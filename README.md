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
The legacy Wercker artifact publisher includes Node 24 dependencies in its ZIP
and uses a separate `node24` release instead of overwriting `latest`, whose
consumers may still expect the old runtime contract. The legacy Lambda deployment
pipeline fails closed unless the owner deliberately sets
`MAILCHIMP_COORDINATED_DEPLOY=true` after coordinating runtime, configuration,
claims, IAM and publisher cutover. It is a code-upload path only: it does not
apply this SAM template or upgrade runtime/configuration. Leave it disabled
unless that separate rollout has been completed. No release or deployment was
performed for this update.

Node 24 is the latest generally available Lambda Node LTS runtime as checked on
2026-10-19; AWS lists Node 26 as preview. AWS SDK v3 Secrets Manager and DynamoDB
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

An owner must supply a **same-account, same-region Secrets Manager secret ARN**
whose JSON string contains fields `apiKey` and `token`. Create and populate a
secret through your secure process if no compatible one is available, or
explicitly select a suitable existing secret. **No suitable secret has been
verified to exist.** The secret must exist before stack deployment; this does
not require creating a new Mailchimp API key or publisher token merely to store
currently valid owner-managed credentials. No actual values belong in this repository, shell arguments, deployment
parameters, logs, or test events. This stack never creates a secret or credential.
Only the secret ARN is placed in the function environment. The token must be
nonempty; the API key's data-center suffix must match `MailchimpHostname`.

Secrets Manager keeps the related credentials together and supports version stages
for coordinated replacement. SSM SecureString would also work for this small
workload, with equivalent custom runtime retrieval and rotation handling. It is
not less secure merely because it is cheaper. The choice here is Secrets Manager
for explicit AWSCURRENT version promotion and coordinated credential replacement,
not automatic Mailchimp rotation. AWS's published examples price Secrets Manager
at $0.40 per secret/month plus $0.05 per 10,000 API calls; one combined secret is
about $0.40/month before usage, taxes, any KMS and other service charges. Standard
SSM parameters at standard throughput have no additional parameter/API charge
(KMS charges may still apply). For infrequent article publishing, fixed storage
cost dominates; SSM would be the lower-cost valid alternative if those version
stages are not useful. This implementation selects Secrets Manager rather than
provisioning both alternatives. Review current region pricing before rollout.
We deliberately do not resolve secrets into Lambda environment variables through
CloudFormation dynamic references: those are resolved during resource updates,
not refreshed merely because the secret changed.

The handler retrieves `AWSCURRENT`, validates it, and caches it in memory for at
most 60 seconds per warm execution environment. Failed refreshes fail closed,
without using stale credentials. Owner-managed rotation must coordinate the
Mailchimp key and publisher token, allowing for this cache interval before
revoking old credentials. There is no automatic Mailchimp rotation provisioned,
no fallback to AWSPREVIOUS, and no retry of failed Mailchimp writes. For urgent
revocation, owner-managed disabling of sending is necessary; a cache cannot
provide immediate global revocation.

The explicit runtime role permits only GetSecretValue on the given secret,
PutItem/UpdateItem on the claims table, and log stream creation/writes on this
stack's log group. It cannot create/update/list secrets, enumerate tables, or
delete claims. If the secret uses a customer-managed KMS key, supply its ARN:
the optional decrypt grant is restricted to that key, Secrets Manager service,
and the secret encryption context. The owner must ensure its key policy permits
the runtime role. The default Secrets Manager AWS-managed key needs no extra
decrypt statement. This is a proposed role only; no IAM changes were applied.
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
3. Through your secure process create/select the secret and supply its ARN,
   Mailchimp hostname, list ID, template ID, sender name and reply address. Check
   existing values privately; placeholders in the export cannot be deployed.
   Review retained logs, backups and policies; avoid API execution data tracing
   or access logs containing request bodies/authorization data.
4. Choose ownership before deploying. This SAM template defines a **new stack**
   with generated names, a single API proxy route, table, role and log group. It
   does not import or overwrite the existing standalone Lambda/API. Plan explicit
   CloudFormation adoption if desired, or a parallel migration. No FunctionName
   is hardcoded to collide with the current function. Review the change set,
   cost, retention and optional KMS grants yourself before any deployment.
5. Keep `SendEnabled=false` initially. Build the Node 24/Linux artifact, validate
   the template and inspect the resulting package. A disabled handler returns
   503 after credential validation without a campaign write. This update's
   verification uses mocks only; it did not read secret values or invoke AWS.
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
- [GetSecretValue permissions, caching and version stages](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)
- [CloudFormation secret reference refresh behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html)
- [DynamoDB conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)
- [Mailchimp send campaign API](https://mailchimp.com/developer/marketing/api/campaigns/create-action-send)
- [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [Systems Manager Parameter Store pricing](https://aws.amazon.com/systems-manager/pricing/)
- [AWS SDK Secrets Manager package](https://www.npmjs.com/package/@aws-sdk/client-secrets-manager)
- [AWS SDK DynamoDB package](https://www.npmjs.com/package/@aws-sdk/client-dynamodb)
