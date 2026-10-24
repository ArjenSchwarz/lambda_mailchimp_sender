'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const digest = value => createHash('sha256').update(value).digest();
const response = (statusCode, message) => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
});

function parseEvent(event) {
  let input = event;
  if (event && typeof event === 'object' && ('httpMethod' in event || event.requestContext?.http)) {
    if ((event.httpMethod || event.requestContext.http.method) !== 'POST') {
      throw new RequestError(405, 'POST required');
    }
    if (typeof event.body !== 'string' || event.body.length > 16384) {
      throw new RequestError(400, 'Invalid request body');
    }
    try {
      input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
    } catch { throw new RequestError(400, 'Invalid JSON'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.title !== 'string' || !input.title.trim() || input.title.length > 998 ||
      /[\r\n]/.test(input.title) || typeof input.token !== 'string' || input.token.length > 4096 ||
      (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 256))) {
    throw new RequestError(400, 'Invalid title, token or id');
  }
  return input;
}

function validateConfig(env) {
  const parameterName = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
  if (!parameterName.test(env.API_KEY_PARAMETER_NAME || '') ||
      !parameterName.test(env.TOKEN_PARAMETER_NAME || '') ||
      env.API_KEY_PARAMETER_NAME === env.TOKEN_PARAMETER_NAME || !env.IDEMPOTENCY_TABLE || !env.LIST_ID ||
      !env.SENDER_NAME || !env.REPLY_TO || !/^[1-9]\d*$/.test(env.TEMPLATE_ID || '') ||
      !Number.isSafeInteger(Number(env.TEMPLATE_ID)) ||
      !/^us\d+\.api\.mailchimp\.com$/.test(env.HOSTNAME || '')) {
    throw new Error('Invalid configuration');
  }
}

// Factories allow tests to replace every network boundary. No request bodies or
// upstream error details are ever logged or returned to API callers.
function createHandler({ env = process.env, parameters, database, fetchImpl = fetch, now = Date.now } = {}) {
  parameters ||= new SSMClient({ maxAttempts: 2 });
  database ||= new DynamoDBClient({ maxAttempts: 2 });
  let cached;
  async function credentials() {
    if (cached && now() < cached.until) return cached.value;
    const names = [env.API_KEY_PARAMETER_NAME, env.TOKEN_PARAMETER_NAME];
    const result = await parameters.send(new GetParametersCommand({ Names: names, WithDecryption: true }),
      { abortSignal: AbortSignal.timeout(3000) });
    if (result.InvalidParameters?.length || !Array.isArray(result.Parameters) || result.Parameters.length !== 2) {
      throw new Error('Incomplete credential parameters');
    }
    // SSM returns results in alphabetical order, not request order. Validate and
    // cache the complete pair only; a partial refresh must never reuse old values.
    const values = new Map();
    for (const parameter of result.Parameters) {
      if (!names.includes(parameter.Name) || values.has(parameter.Name) ||
          parameter.Type !== 'SecureString' || typeof parameter.Value !== 'string') {
        throw new Error('Invalid credential parameters');
      }
      values.set(parameter.Name, parameter.Value);
    }
    const value = { apiKey: values.get(env.API_KEY_PARAMETER_NAME), token: values.get(env.TOKEN_PARAMETER_NAME) };
    const region = env.HOSTNAME.split('.')[0];
    if (typeof value.apiKey !== 'string' || !value.apiKey.endsWith(`-${region}`) ||
        value.apiKey.length < region.length + 2 || typeof value.token !== 'string' ||
        !value.token.trim() || value.token.length > 4096) throw new Error('Invalid credential parameters');
    cached = { value, until: now() + 60000 };
    return value;
  }
  async function record(key, state, campaignId) {
    await database.send(new UpdateItemCommand({
      TableName: env.IDEMPOTENCY_TABLE, Key: { id: { S: key } },
      UpdateExpression: 'SET #state = :state, campaignId = :campaign',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': { S: state }, ':campaign': { S: campaignId || 'unknown' } },
    }), { abortSignal: AbortSignal.timeout(3000) });
  }
  async function mailchimp(path, method, body, apiKey) {
    // Never retry a write: timeout/disconnect may mean the write already succeeded.
    const result = await fetchImpl(`https://${env.HOSTNAME}/3.0/campaigns${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Basic ${Buffer.from(`lambda:${apiKey}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!result.ok) throw new Error('Mailchimp request failed');
    if (method === 'POST' && path === '') {
      const campaign = await result.json();
      if (typeof campaign.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(campaign.id)) throw new Error('Invalid campaign response');
      return campaign.id;
    }
    // Consume the response before proceeding to the next operation.
    await result.text();
  }
  return async event => {
    let key, campaignId, claimed = false;
    try {
      const input = parseEvent(event);
      validateConfig(env);
      const secret = await credentials();
      if (!timingSafeEqual(digest(input.token), digest(secret.token))) throw new RequestError(403, 'Forbidden');
      if (env.SEND_ENABLED !== 'true') throw new RequestError(503, 'Sending disabled');
      // Title fallback preserves existing callers; stable publisher IDs are preferred.
      key = digest(JSON.stringify([env.HOSTNAME, env.LIST_ID, input.id === undefined ? 'title' : 'id', input.id ?? input.title])).toString('hex');
      try {
        await database.send(new PutItemCommand({
          TableName: env.IDEMPOTENCY_TABLE,
          Item: { id: { S: key }, state: { S: 'CLAIMED' } },
          ConditionExpression: 'attribute_not_exists(id)',
        }), { abortSignal: AbortSignal.timeout(3000) });
        claimed = true;
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') throw new RequestError(409, 'Already claimed; review before retrying');
        throw error;
      }
      campaignId = await mailchimp('', 'POST', {
        type: 'regular', recipients: { list_id: env.LIST_ID },
        settings: { subject_line: input.title, title: input.title, from_name: env.SENDER_NAME, reply_to: env.REPLY_TO, inline_css: true },
      }, secret.apiKey);
      await record(key, 'CREATED', campaignId);
      await mailchimp(`/${campaignId}/content`, 'PUT', { template: { id: Number(env.TEMPLATE_ID) } }, secret.apiKey);
      await record(key, 'SEND_REQUESTED', campaignId);
      await mailchimp(`/${campaignId}/actions/send`, 'POST', undefined, secret.apiKey);
      await record(key, 'SEND_ACCEPTED', campaignId);
      return response(200, 'Campaign send accepted');
    } catch (error) {
      if (claimed) {
        try { await record(key, 'REVIEW_REQUIRED', campaignId); } catch { /* Keep the permanent claim. */ }
      }
      return response(error instanceof RequestError ? error.status : 502,
        error instanceof RequestError ? error.message : 'Operation failed; review campaign status before retrying');
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
