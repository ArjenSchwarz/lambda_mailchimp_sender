# Changelog

## [Unreleased]

### Added
- Fog parameter and tag files for the sender.
- Runtime retrieval of two standard SecureString parameters with validated credentials and a 60-second cache.
- Durable conditional campaign claims and mocked regression coverage for partial failures.
- Parameterized SAM infrastructure, scoped runtime permissions, and owner rollout guidance.

### Changed
- Populate sender parameters with the configured blog audience and sender settings.
- Prefer ARM64 and organize application files under code/ and infrastructure under templates/.
- Condense the README to purpose, setup, usage and essential operating instructions.
- Target Node.js 24 and bundle pinned AWS SDK v3 SSM and DynamoDB dependencies.
- Use the default AWS-managed aws/ssm key and exact parameter-scoped reads without an additional KMS grant.
- Await and check campaign creation, template assignment, and send acceptance.
- Accept direct events and API proxy JSON with optional stable article identifiers.
- Keep sending disabled by default.

### Fixed
- Prevent duplicate campaign attempts after concurrent invocations or uncertain failures.

### Removed
- Obsolete Wercker build, release and Lambda deployment configuration.
