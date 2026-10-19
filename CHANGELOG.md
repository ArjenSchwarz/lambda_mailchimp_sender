# Changelog

## [Unreleased]

### Added
- Runtime Secrets Manager retrieval with validated credentials and a 60-second cache.
- Durable conditional campaign claims and mocked regression coverage for partial failures.
- Parameterized SAM infrastructure, scoped runtime permissions, and owner rollout guidance.

### Changed
- Target Node.js 24 and bundle pinned AWS SDK v3 dependencies.
- Await and check campaign creation, template assignment, and send acceptance.
- Accept direct events and API proxy JSON with optional stable article identifiers.
- Keep sending disabled by default and gate legacy uploads behind coordinated owner rollout.
- Publish Node 24 artifacts separately from the legacy latest release.

### Fixed
- Prevent duplicate campaign attempts after concurrent invocations or uncertain failures.
- Correct legacy publisher YAML step mappings and include runtime dependencies in its ZIP.
