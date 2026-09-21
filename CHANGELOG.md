# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Dedicated ARM64 asset worker, exported live alias, least-privilege workspace
  access, alarms, and Static Publisher exporter 1.1.65 compatibility.

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
