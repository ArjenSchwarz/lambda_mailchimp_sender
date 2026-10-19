'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../index');
const env = { SECRET_ARN: 'synthetic', IDEMPOTENCY_TABLE: 'test', HOSTNAME: 'us1.api.mailchimp.com', LIST_ID: 'synthetic-list', TEMPLATE_ID: '123', SENDER_NAME: 'Test', REPLY_TO: 'test@example.invalid', SEND_ENABLED: 'true' };
const event = { title: 'Synthetic test', token: 'synthetic-token', id: 'article-1' };
function fixture(options = {}) {
  const calls = [], claims = new Set(), records = [];
  let secretReads = 0, clock = 0;
  const handler = createHandler({ env: { ...env, ...options.env }, now: () => clock,
    secrets: { send: async () => { secretReads++; return { SecretString: JSON.stringify({ apiKey: 'synthetic-us1', token: 'synthetic-token' }) }; } },
    database: { send: async command => {
      const data = command.input;
      if (command.constructor.name === 'PutItemCommand') {
        if (claims.has(data.Item.id.S)) { const error = new Error(); error.name = 'ConditionalCheckFailedException'; throw error; }
        claims.add(data.Item.id.S);
      } else records.push(data.ExpressionAttributeValues[':state'].S);
      return {};
    } },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      if (options.throwAt === calls.length) throw new Error('synthetic upstream failure');
      return { ok: options.failAt !== calls.length, json: async () => options.invalidId ? {} : { id: 'campaign-1' }, text: async () => '' };
    },
  });
  return { handler, calls, records, tick: n => { clock += n; }, reads: () => secretReads };
}
test('awaits create, content, send and keeps the original campaign settings', async () => {
  const f = fixture();
  assert.equal((await f.handler(event)).statusCode, 200);
  assert.deepEqual(f.calls.map(c => c.method), ['POST', 'PUT', 'POST']);
  assert.deepEqual(f.records, ['CREATED', 'SEND_REQUESTED', 'SEND_ACCEPTED']);
  assert.equal(JSON.parse(f.calls[0].body).settings.subject_line, event.title);
  assert.equal(JSON.parse(f.calls[1].body).template.id, 123);
  assert.match(f.calls[2].url, /campaign-1\/actions\/send$/);
});
test('rejects missing/wrong token, malformed JSON and invalid title without writes', async () => {
  const f = fixture();
  for (const input of [{ title: 'x' }, { ...event, token: 'wrong' }, { ...event, title: 'a\nb' }, { httpMethod: 'POST', body: '{' }]) {
    assert.ok([400, 403].includes((await f.handler(input)).statusCode));
  }
  assert.equal(f.calls.length, 0);
});
test('supports proxy JSON/base64 and legacy direct payloads', async () => {
  for (const base64 of [false, true]) {
    const f = fixture(), json = JSON.stringify(event);
    assert.equal((await f.handler({ httpMethod: 'POST', isBase64Encoded: base64, body: base64 ? Buffer.from(json).toString('base64') : json })).statusCode, 200);
  }
});
test('disabled sending and bad configuration fail closed', async () => {
  for (const config of [{ SEND_ENABLED: 'false' }, { HOSTNAME: 'attacker.invalid' }, { TEMPLATE_ID: '1x' }]) {
    const f = fixture({ env: config });
    assert.ok((await f.handler(event)).statusCode >= 500);
    assert.equal(f.calls.length, 0);
  }
});
test('durable claims block repeated and concurrent events', async () => {
  const f = fixture();
  const results = await Promise.all([f.handler(event), f.handler(event)]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await f.handler(event)).statusCode, 409);
  assert.equal(f.calls.length, 3);
});
test('title fallback deduplicates old callers while stable IDs allow repeated subjects', async () => {
  const f = fixture(), legacy = { title: 'Same title', token: event.token };
  assert.equal((await f.handler(legacy)).statusCode, 200);
  assert.equal((await f.handler(legacy)).statusCode, 409);
  assert.equal((await f.handler({ ...legacy, id: 'different-article' })).statusCode, 200);
});
for (const step of [1, 2, 3]) {
  for (const mode of ['failAt', 'throwAt']) {
    test(`${mode} at step ${step} stops the pipeline and never retries`, async () => {
      const f = fixture({ [mode]: step });
      const result = await f.handler(event);
      assert.equal(result.statusCode, 502);
      assert.equal(f.calls.length, step);
      assert.equal((await f.handler(event)).statusCode, 409);
      assert.equal(f.calls.length, step);
      assert.equal(f.records.at(-1), 'REVIEW_REQUIRED');
      assert.ok(!result.body.includes('synthetic upstream'));
    });
  }
}
test('invalid campaign response prevents content/send', async () => {
  const f = fixture({ invalidId: true });
  assert.equal((await f.handler(event)).statusCode, 502);
  assert.equal(f.calls.length, 1);
});
test('secrets cache expires after 60 seconds', async () => {
  const f = fixture();
  await f.handler({ ...event, token: 'wrong' });
  await f.handler({ ...event, token: 'wrong' });
  assert.equal(f.reads(), 1);
  f.tick(60000);
  await f.handler({ ...event, token: 'wrong' });
  assert.equal(f.reads(), 2);
});
test('unreadable/malformed secrets fail closed before storage or Mailchimp', async () => {
  for (const secrets of [
    { send: async () => { throw new Error('sensitive upstream detail'); } },
    { send: async () => ({ SecretString: '{' }) },
    { send: async () => ({ SecretString: JSON.stringify({ apiKey: 'synthetic-us2', token: 'synthetic-token' }) }) },
  ]) {
    let writes = 0;
    const handler = createHandler({ env, secrets,
      database: { send: async () => { writes++; } },
      fetchImpl: async () => { throw new Error('must not call'); },
    });
    const result = await handler(event);
    assert.equal(result.statusCode, 502);
    assert.equal(writes, 0);
    assert.ok(!result.body.includes('sensitive'));
  }
});
test('claim/storage failures never start Mailchimp writes', async () => {
  let requests = 0;
  const handler = createHandler({ env,
    secrets: { send: async () => ({ SecretString: JSON.stringify({ apiKey: 'synthetic-us1', token: 'synthetic-token' }) }) },
    database: { send: async () => { throw new Error('storage unavailable'); } },
    fetchImpl: async () => { requests++; },
  });
  assert.equal((await handler(event)).statusCode, 502);
  assert.equal(requests, 0);
});
test('failure to persist campaign ID stops before content or send', async () => {
  let requests = 0;
  const handler = createHandler({ env,
    secrets: { send: async () => ({ SecretString: JSON.stringify({ apiKey: 'synthetic-us1', token: 'synthetic-token' }) }) },
    database: { send: async command => { if (command.constructor.name === 'UpdateItemCommand') throw new Error('storage unavailable'); } },
    fetchImpl: async () => { requests++; return { ok: true, json: async () => ({ id: 'campaign-1' }) }; },
  });
  assert.equal((await handler(event)).statusCode, 502);
  assert.equal(requests, 1);
});
for (const failedState of ['SEND_REQUESTED', 'SEND_ACCEPTED']) {
  test(`failed ${failedState} persistence retains the claim and cannot resend`, async () => {
    let claimed = false, requests = 0;
    const handler = createHandler({ env,
      secrets: { send: async () => ({ SecretString: JSON.stringify({ apiKey: 'synthetic-us1', token: 'synthetic-token' }) }) },
      database: { send: async command => {
        if (command.constructor.name === 'PutItemCommand') {
          if (claimed) { const error = new Error(); error.name = 'ConditionalCheckFailedException'; throw error; }
          claimed = true;
        } else if (command.input.ExpressionAttributeValues[':state'].S === failedState) {
          throw new Error('storage unavailable');
        }
      } },
      fetchImpl: async () => { requests++; return { ok: true, json: async () => ({ id: 'campaign-1' }), text: async () => '' }; },
    });
    assert.equal((await handler(event)).statusCode, 502);
    assert.equal(requests, failedState === 'SEND_REQUESTED' ? 2 : 3);
    assert.equal((await handler(event)).statusCode, 409);
    assert.equal(requests, failedState === 'SEND_REQUESTED' ? 2 : 3);
  });
}
test('uncertain persisted claim never starts a campaign and blocks subsequent retry', async () => {
  let claimed = false, requests = 0;
  const handler = createHandler({ env,
    secrets: { send: async () => ({ SecretString: JSON.stringify({ apiKey: 'synthetic-us1', token: 'synthetic-token' }) }) },
    database: { send: async () => {
      if (!claimed) { claimed = true; throw new Error('response lost after durable write'); }
      const error = new Error(); error.name = 'ConditionalCheckFailedException'; throw error;
    } },
    fetchImpl: async () => { requests++; },
  });
  assert.equal((await handler(event)).statusCode, 502);
  assert.equal((await handler(event)).statusCode, 409);
  assert.equal(requests, 0);
});
test('expired cached secret is not used when refresh fails', async () => {
  let clock = 0, reads = 0, requests = 0;
  const handler = createHandler({ env, now: () => clock,
    secrets: { send: async () => {
      if (++reads > 1) throw new Error('secret service unavailable');
      return { SecretString: JSON.stringify({ apiKey: 'synthetic-us1', token: 'synthetic-token' }) };
    } },
    database: { send: async () => ({}) },
    fetchImpl: async () => { requests++; return { ok: true, json: async () => ({ id: 'campaign-1' }), text: async () => '' }; },
  });
  assert.equal((await handler(event)).statusCode, 200);
  clock = 60000;
  assert.equal((await handler({ ...event, id: 'article-2' })).statusCode, 502);
  assert.equal(requests, 3);
});
