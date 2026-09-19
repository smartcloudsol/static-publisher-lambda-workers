# Security Policy

## Supported versions

Security fixes are provided for the latest released minor line. Before the
first stable release, only the latest `0.1.x` release is supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory workflow in this repository and include:

- the affected version or commit;
- the configuration and AWS services involved, with account IDs and secrets
  removed;
- reproducible steps or a minimal proof of concept;
- expected and observed impact; and
- any known mitigation.

Please allow the maintainers time to confirm the report and coordinate a fix
before public disclosure. Never include AWS credentials, generated
`remote-workers.json`, CDK context, customer URLs, task payloads, logs, or
traces containing personal data in a report.

## Operational scope

This repository deploys infrastructure into the operator's AWS account. The
operator remains responsible for account access controls, CloudTrail, security
monitoring, network egress policy, patching the coordinator host, KMS policies,
and reviewing every `cdk diff` before deployment.
