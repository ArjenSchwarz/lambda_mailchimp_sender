# Mailchimp sender Lambda

Creates a **regular** Mailchimp campaign, assigns a saved template, then requests
its send. The template supplies the RSS content; this function never reads RSS.
Mailchimp accepting the request does not establish inbox delivery.

## Runtime and local checks

Use Node.js 24 (`nvm use`) and `npm ci --ignore-scripts`. Run `npm test`,
`npm run check`, and `sam validate --lint`. Tests replace all AWS and Mailchimp
network boundaries and use synthetic values only. Never use the real sender as a
test. `sam build --use-container` produces the Linux deployment artifact when
Docker is available; inspect it for `index.js` and both pinned AWS SDK packages.

Node 24 is the latest generally available Lambda Node LTS runtime as checked on
2026-10-19; AWS lists Node 26 as preview. AWS SDK v3 SSM and DynamoDB
clients are pinned to 3.1152.0 with a lockfile (their engines require Node >=20).
No Mailchimp SDK is needed: Node's built-in fetch calls the existing API v3 paths.

## Caller contract

Direct Lambda callers send `{ "title": "Article subject", "token": "<caller supplied>",
"id": "<stable article identifier>" }`. API Gateway callers POST the same JSON
object as the body to `/mailchimpsender`, with `Content-Type: application/json`.
`id` is optional for existing callers; use an immutable article ID or canonical
URL for new publishers and reuse it on every retry. Never log the payload or token.

Title and token remain required. The regular campaign, list selection, subject,
internal title, sender, reply address, inline CSS, and template assignment retain
the original behavior. The function now awaits the complete sequence, checks
HTTP status, restricts the Mailchimp hostname, times out calls, and fails closed.
The response has `statusCode`, JSON `headers`, and a JSON `body` for API proxy use.
Direct callers must inspect `statusCode`; returned failures are not Lambda errors.

Responses: 200 send accepted; 400 invalid input; 403 token mismatch; 405 wrong HTTP
method; 409 previously claimed event; 503 sending disabled; 502 configuration,
credential, storage or upstream failure. No upstream response bodies are exposed.
Existing custom API response mappings may mask status codes; review at cutover.

## Credentials and permissions

The owner must create/select two **same-account, same-region standard-tier
SecureString parameters**, each encrypted with the default AWS-managed `aws/ssm`
key. No suitable parameters have been verified to exist, and this stack creates
neither parameters nor credentials. Existing valid owner-managed Mailchimp/API
credentials can be stored; new credentials are not inherently required.

| Parameter name (default) | Value stored by owner | SAM parameter / function environment |
| --- | --- | --- |
| `/mailchimpsender/api-key` | Mailchimp API key as a raw string | `ApiKeyParameterName` / `API_KEY_PARAMETER_NAME` |
| `/mailchimpsender/token` | Publisher authentication token as a raw string | `TokenParameterName` / `TOKEN_PARAMETER_NAME` |

These are two individual raw string values, **not JSON objects**. Both parameter
names must be distinct absolute paths. The API key suffix must match
`MailchimpHostname`; the token must be nonempty. Each standard parameter is
limited to 4 KiB. Keep actual values out of this repository, shell arguments,
deployment inputs, logs and test events. Only the two names enter Lambda's
environment; IAM ARNs are derived using the deployment account and region.

Owner setup (not performed): in the intended account/region, use the Systems
Manager Parameter Store console or your secure credential-management workflow.
For each name above, select **Standard**, type **SecureString**, and the default
KMS key **`alias/aws/ssm`**. Enter its raw value privately and save. Do not select
Advanced, a customer-managed key, or a Secrets Manager reference path. Before
rollout, verify both names, type, tier and key privately; the handler validates
the returned type and values, but GetParameters does not report tier or key ID.
If selecting other absolute paths, pass those exact names as the SAM inputs.
The function needs no create/update permissions, and setup must be completed by
the owner before any deployment or activation.

The handler makes one `GetParameters` call with the two exact names and
`WithDecryption: true`, validates both results by name and `SecureString` type,
then caches the complete pair for at most 60 seconds per warm execution
environment. Partial results, invalid types/values, denied reads and failed
refreshes fail closed; expired values are never reused. It reads the latest
values rather than version labels. Two parameters can be updated independently,
so retrieval is **not an atomic credential-pair rotation**. To rotate, pause
publishing and disable sending, update both parameters and the publisher through
your secure process, allow at least the cache interval to expire, then coordinate
re-enabling. There is no automatic Mailchimp rotation, stale fallback, or retry
of failed Mailchimp writes. A cache cannot provide immediate global revocation.

The explicit runtime role allows only `ssm:GetParameters` on the two exact
parameter ARNs, PutItem/UpdateItem on the claims table, and stream creation/writes
on this stack's log group. It has no GetParametersByPath, GetParameterHistory,
parameter creation/update, Secrets Manager access, table enumeration or claim
deletion permission. The default `aws/ssm` key grants decrypt permission to IAM
principals within the account, so this template adds **no KMS permission** and
creates no KMS key. SSM read permissions remain the access boundary here; the
default key does not provide per-parameter key-policy isolation. Existing explicit
denies or organization controls can still block retrieval. No IAM or key-policy
changes were applied. Customer-managed keys are outside this design.

Standard parameters and standard-throughput Parameter Store API calls have no
additional Parameter Store charge. There is no Secrets Manager resource or
per-secret storage charge, and no customer-managed key storage charge. AWS KMS
usage charges can still apply; this is not a claim that the whole application is
free. Existing Lambda/API/logging and retained DynamoDB/backup charges remain.
Keep standard tier and standard throughput rather than enabling chargeable
advanced/high-throughput features for this infrequent workload.

List ID is audience metadata, not a credential, and remains an owner-supplied
NoEcho deployment parameter. Sender details and template ID are configuration.

## Duplicate protection and recovery

Before any Mailchimp write, DynamoDB conditionally claims a SHA-256 key over the
hostname, audience ID, and event ID (or exact subject for legacy callers). Claims
have **no TTL** and the table is retained across stack deletion/replacement.
An atomic conditional write admits only one invocation per key. This deliberately
trades automatic recovery for avoiding unintended sends. Reusing a subject without
an ID blocks a legitimate later article with the same subject; stable IDs fix that.
Changing an event ID or audience bypasses deduplication, so retry identities must
remain stable. Changing an existing publisher from title fallback to IDs also
requires draining pending retries first.

Shared durable storage is needed because concurrent Lambda environments, process
restarts and sequential retries cannot share an in-memory sent flag. Reducing
concurrency alone does not prevent a later replay. Mailchimp's three API writes
are not one transaction with our caller. Retaining the table prevents a stack
recreation from silently forgetting attempted sends. Permanent claims are a
conservative policy, not the only possible design: a finite expiry would allow
an old retry to send again after that window. No trustworthy maximum retry
window is established here, so there is no automatic expiry. On-demand table
requests, storage and point-in-time recovery add charges; this is a small but
explicit extra resource. A publisher with a proven durable deduplication system
could later replace this guard after its retry contract is established.

Records progress through CLAIMED, CREATED, SEND_REQUESTED and SEND_ACCEPTED, with
the campaign ID when known. Failures after a claim are marked REVIEW_REQUIRED
when possible; a process kill or storage outage can leave an earlier state.
Claims are never automatically removed, even if campaign creation failed. A
successful claim whose response is lost can leave a claim with no campaign;
409 therefore does not prove a campaign was created or sent. A
network timeout may mean Mailchimp accepted the operation. Inspect Mailchimp and
the record manually before deciding what happened; do not simply generate a new
ID or delete a claim. If creation returned no ID, identify any campaign in
Mailchimp manually. Never automatically resend an uncertain send. The owner
must perform any email send or deliberate recovery themselves. This is an
at-most-one-attempt guard per retained claim, not a cross-system exactly-once
transaction or proof of delivery. A new empty table loses existing deduplication
history; preserve the table and migrate claims before switching stacks.

## Owner rollout checklist (not performed)

1. Verify account, region and resource ownership. Read-only inspection on
   2026-10-19 confirmed the intended account in us-east-1, function `mailchimpsender`,
   Node 10, 30-second timeout, and no aliases. Published versions 1 and 2 use Node
   4.3. The existing API, POST `/mailchimpsender`, has an AWS custom integration
   targeting the **unqualified function**, with production stage `prod`. Its one
   request mapping is registered for `application/x-www-form-urlencoded` and
   references `$input.json`; passthrough is WHEN_NO_MATCH. Actual publisher
   payloads and historic stage deployment integration snapshots were not retrieved.
2. Identify the publisher, actual content type, response expectations, pending
   retries, and all callers of `$LATEST`, versions 1/2, stage snapshots or cached
   URLs. Do not delete old versions merely because no aliases exist. Preserve any
   external API authorization/domain/usage-plan configuration during migration.
3. Through your secure process create/select the two standard SecureString
   parameters with the default `aws/ssm` key, and supply their exact names,
   Mailchimp hostname, list ID, template ID, sender name and reply address. Check
   existing values privately; placeholders in the export cannot be deployed.
   Review retained logs, backups and policies; avoid API execution data tracing
   or access logs containing request bodies/authorization data.
4. Choose ownership before deploying. This SAM template defines a **new stack**
   with generated names, a single API proxy route, table, role and log group. It
   does not import or overwrite the existing standalone Lambda/API. Plan explicit
   CloudFormation adoption if desired, or a parallel migration. No FunctionName
   is hardcoded to collide with the current function. Review the change set,
   cost, retention and scoped SSM access yourself before any deployment.
5. Keep `SendEnabled=false` initially. Build the Node 24/Linux artifact, validate
   the template and inspect the resulting package. A disabled handler returns
   503 after credential validation without a campaign write. This update's
   verification uses mocks only; it did not read parameter values or invoke AWS.
6. Pause the publisher and drain retries before switching the endpoint/integration.
   Prevent both old and new senders from processing the same article: the old
   implementation does not share the claims table. Preserve old custom mappings
   if keeping that API, or adapt the publisher to the new JSON proxy contract.
   The existing prod URL and new SAM `/Prod/` URL differ. API Gateway's client
   timeout can expire before a Lambda finishes; retry with the same ID and review
   ambiguous outcomes, never automatically change identities.
7. The owner may enable sending and send a deliberate campaign themselves after
   review. Observe campaign/claim state and reconcile results manually. Do not
   use Lambda console test, real Mailchimp write endpoints, or automated CI smoke
   sends for verification. Coordinate rollback so old/new senders cannot overlap;
   restoring Node 10/4.3 is not a supported runtime rollback. Retain claim history.

## References checked 2026-10-19

- [AWS Lambda supported runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)
- [AWS Node deployment packages and bundled SDK guidance](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html)
- [SSM GetParameters and response ordering](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameters.html)
- [SecureString encryption and default key](https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html)
- [Default aws/ssm decrypt permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-restrict-decryption.html)
- [DynamoDB conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)
- [Mailchimp send campaign API](https://mailchimp.com/developer/marketing/api/campaigns/create-action-send)
- [Systems Manager Parameter Store pricing](https://aws.amazon.com/systems-manager/pricing/)
- [AWS SDK SSM package](https://www.npmjs.com/package/@aws-sdk/client-ssm)
- [AWS SDK DynamoDB package](https://www.npmjs.com/package/@aws-sdk/client-dynamodb)
