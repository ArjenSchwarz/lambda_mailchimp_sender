# Mailchimp sender Lambda

Send a Mailchimp campaign when an article is published, without waiting for a
scheduled RSS campaign. The Lambda creates a regular campaign, applies a saved
Mailchimp template and requests a send. The template supplies the content; the
Lambda does not fetch RSS feeds itself.

## Setup

Requires Node.js 24, AWS SAM CLI, and a Mailchimp audience and saved template.

Create these two Parameter Store parameters in the Lambda's account and region.
Use **Standard** tier, **SecureString** type and the default **`alias/aws/ssm`** key.
Store each value as a raw string, not JSON; keep credentials out of source and logs.

| Default parameter name | Value |
| --- | --- |
| `/mailchimpsender/api-key` | Mailchimp API key |
| `/mailchimpsender/token` | Nonempty token shared with the publisher |

Configure [template.yaml](template.yaml) with:

| SAM input | Value |
| --- | --- |
| `ApiKeyParameterName`, `TokenParameterName` | The two distinct parameter paths above, or your own absolute paths |
| `MailchimpHostname` | API hostname, such as `us1.api.mailchimp.com`; must match the API key's data-center suffix |
| `ListId`, `TemplateId` | Audience ID and saved template ID |
| `SenderName`, `ReplyTo` | Campaign sender name and reply address |
| `SendEnabled` | Defaults to `false`; set to `true` when ready to send |

Build with `sam build --use-container` (requires Docker), then deploy with
`sam deploy --guided`. SAM creates the function, API, runtime role, logs and
retained DynamoDB claims table; it does not create the credential parameters.
For an existing installation, review the change set and coordinate the publisher
cutover: this template does not import existing resources automatically. Avoid
running old and new senders for the same article.

## Usage

POST JSON to the stack's `Endpoint` output, or invoke the Lambda directly with
the same object:

```json
{
  "title": "Article subject",
  "token": "<publisher-token>",
  "id": "article-123"
}
```

For HTTP requests, use `Content-Type: application/json`. `title` and `token` are
required. Use a stable article ID or canonical URL for `id`, and reuse it on
retries. Without `id`, the exact title identifies the article, so repeated
subjects are blocked.

The response contains `statusCode` and a JSON `body`; direct callers must inspect
`statusCode`. `200` means Mailchimp accepted the send request, not that delivery
completed. `409` means the article was already claimed; `503` means sending is
disabled.

Claims never expire, including after failures. For an error or uncertain result,
inspect the claim and Mailchimp campaign before recovery. Do not bypass a claim
by changing the article ID or deleting the record. Preserve claim history when
replacing infrastructure. Perform deliberate sends and recovery manually.

Credentials are cached for 60 seconds; failed refreshes stop processing. To
rotate them, pause publishing and disable sending, update both parameters and
the publisher, allow the cache interval to expire, then re-enable. Updating the
two parameters is not atomic.

## Development

```sh
nvm use
npm ci --ignore-scripts
npm test
npm run check
sam validate --lint
```

Tests use mocked AWS and Mailchimp clients with synthetic inputs. Do not use a
live sender invocation as a test.
