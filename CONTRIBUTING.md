# Contributing

## Local setup

Use a supported Node.js release and install the locked dependency tree:

```bash
npm ci
```

Before opening a pull request, run:

```bash
npm run check
npm run audit:prod
npm run synth:ci
```

The fixture synth does not require AWS credentials or Docker. Run a real
environment synth only with an ignored local configuration file. Never commit
account data, CDK context, generated runtime configuration, build output,
exporter tarballs, logs, or credentials.

## Infrastructure changes

- Prefer AWS CDK L2 constructs and least-privilege grants.
- Add or update assertion tests for every resource, permission, alarm, and
  configuration rule that changes.
- Review create and delete dependencies and AWS naming constraints.
- Do not rename constructs or change a retained CloudFormation logical ID's
  resource type without a documented migration plan.
- Treat VPC, IAM, bucket retention, KMS, and deletion changes as high risk.
- Use ordinary hyphens in AWS names and descriptions.

A pull request must not deploy, publish, bootstrap an account, or commit a real
`cdk diff`. Deployment is an explicit maintainer operation after review.
