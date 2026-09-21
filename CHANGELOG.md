# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Direct, conditionally ordered worker progress updates in a DynamoDB status
  table with TTL, plus read-only exporter status access.
- Dedicated ARM64 asset worker, exported live alias, least-privilege workspace
  access, alarms, and Static Publisher exporter 1.1.65 compatibility.
- Safe dual-remote publishing with an explicit public-source allowlist and
  leak checks before updating the public repository.

### Fixed

- Preserve origin response MIME types through rewrite, use extension inference
  only as a fallback, and recopy unchanged bodies when target Content-Type
  metadata differs.
- Add the required DynamoDB gateway endpoint to worker route tables so progress
  writes cannot stall inside VPC-attached Lambdas without NAT egress. Endpoint
  creation defaults to enabled so existing pipeline configs are safe.

## [0.1.0] - 2026-09-19

### Added

- Standalone CDK deployment for render, rewrite, and deploy-copy Lambda workers.
- Versioned worker aliases and a scoped exporter access role.
- Explicit VPC proxy or NAT egress configuration and optional S3 gateway endpoint.
- Strict configuration validation for AWS identifiers, S3 boundaries, and targets.
- Active X-Ray tracing, finite log retention, and CloudWatch alarms.
- Credential-free strict synthesis fixture and GitHub Actions quality gates.

[Unreleased]: https://github.com/smartcloudsol/static-publisher-lambda-workers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/smartcloudsol/static-publisher-lambda-workers/releases/tag/v0.1.0
