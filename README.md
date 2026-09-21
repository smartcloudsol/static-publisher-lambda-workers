# Static Publisher Lambda Workers

An AWS CDK application that deploys bounded remote workers for the expensive
parts of a [SmartCloud Static Publisher](https://github.com/smartcloudsol/static-publisher)
run. The EC2-side exporter remains the coordinator: it owns crawl decisions,
task IDs, manifests, retries, and job state. The Lambda workers process only the
operation and S3 locations allowed by the deployed configuration.

The stack creates four independently sized container-image functions from the
same worker image source:

- `render` runs Playwright in the selected VPC subnets;
- `asset` fetches discovered assets through the same VPC/proxy path and writes
  them to the workspace;
- `rewrite` rewrites staged text objects outside the VPC;
- `deploy-copy` performs server-side S3 copies and explicit deletions within
  allowlisted target prefixes.

Each function has a versioned `live` alias, reserved concurrency, a finite log
retention period, active X-Ray tracing, and CloudWatch alarms for errors,
throttles, and p99 duration. The stack also creates an `ExporterAccessRole`
trusted by the configured EC2 role. Generated exporter configuration refers to
aliases, never mutable unqualified function names.

Workers write metadata-only progress rows directly to an encrypted DynamoDB
table with TTL cleanup. Conditional sequence checks prevent delayed updates
from replacing newer state. Each worker role can perform only `UpdateItem`,
while the exporter role can perform only `GetItem` against that table. Progress
write failures are logged but never turn completed export work into a failed
task.

## Prerequisites

- Node.js 20-24 and npm
- Docker for building the Lambda container image during deployment
- Docker buildx when the selected Lambda architecture differs from the host
- AWS credentials allowed to bootstrap and deploy CDK, create IAM roles, and
  pass the created execution roles
- a bootstrapped target account and Region (`npx cdk bootstrap` once)
- Static Publisher exporter 1.1.66 or newer
- one verified render/asset egress path: a private forward proxy or NAT from
  private subnets

## Install and validate

```bash
npm ci
npm run check
npm run audit:prod
npm run synth:ci
```

`synth:ci` uses a credential-free fixture. It proves that the application can
strictly synthesize, but it does not validate the route tables, security group
rules, proxy reachability, account quotas, or permissions in your AWS account.

Copy `config/environments/example.json` to the ignored
`config/environments/local.json` and change every example value. Never commit
the local file, generated `remote-workers.json`, CDK outputs, or context data.

Important configuration fields:

- `account`, `region`, and `stackName` identify the deployment. If `account` is
  present, it must match the account in `callerRoleArn`.
- `callerRoleArn` is the EC2 instance-profile role allowed to assume the
  generated exporter role.
- `attachCallerPolicy` controls whether CDK attaches its generated
  `sts:AssumeRole` policy to that same-account role. When false, attach the
  `ExporterCallerPolicyArn` output through your normal IAM process.
- `publisherExporterVersion` pins the exact worker implementation. Asset
  delegation requires 1.1.65 or newer and live progress requires 1.1.66 or
  newer.
- `publisherExporterSource` is `npm` for a published release or
  `local-tarball` for a local exporter checkout.
- Set exactly one of `network.vpcId` or `network.useDefaultVpc: true`.
- `network.renderEgress` is `proxy` or `nat`. Proxy mode requires a matching
  `proxyUrl` and `proxyPort`. NAT mode requires an explicit VPC; Lambda ENIs in
  default-VPC public subnets do not receive public IP addresses.
- `network.subnetIds` and `securityGroupIds` select exact existing resources.
  With no subnet IDs, an explicit VPC selects private-with-egress subnets;
  default-VPC mode selects public subnets and therefore requires proxy egress.
- `network.createS3GatewayEndpoint` keeps workspace S3 traffic off the proxy or
  NAT. Explicit subnet IDs also require their explicit route table IDs.
- `workspace.prefix` and every target `prefix` must be non-empty. Sharing a
  bucket is supported only when each deployment owns a disjoint prefix.
- `targets` is the complete deploy-copy allowlist. Use an empty array for a
  render/asset/rewrite-only deployment. Target IDs must be unique.
- `workers.assetMemoryMiB`, `assetTimeoutSeconds`, and
  `assetEphemeralStorageMiB` independently size asset fetch invocations. The
  asset worker is always ARM64; `workers.architecture` continues to select the
  architecture of the render, rewrite, and deploy-copy workers.
- `workers.assetConcurrency` is the function's reserved-concurrency capacity:
  it reserves account capacity and provides the stack-level safety ceiling for
  simultaneous asset invocations. It is not the per-job Lambda fan-out shown
  in WordPress admin. The coordinator requests that job fan-out independently,
  and effective parallelism cannot exceed this infrastructure ceiling.

When `manageOriginIngress` is true, the stack adds ingress to
`originSecurityGroupId` from the worker security groups on `proxyPort`. The
proxy must not be internet-open, and its own egress policy should restrict the
destinations the render and asset workers may reach. When existing worker
security groups are supplied, the operator remains responsible for their
outbound rules.

## Local exporter builds

For unreleased exporter testing, use `publisherExporterSource: local-tarball`.
The preparation script verifies that the local package version exactly matches
`publisherExporterVersion`, runs `npm pack`, and places the ignored tarball in
the local worker build context.

The default source checkout is `../static-publisher/exporter` relative to this
standalone repository. Override it explicitly when the repositories live
elsewhere:

```bash
PUBLISHER_EXPORTER_SOURCE_DIR=/absolute/path/to/static-publisher/exporter \
  ./scripts/synth.sh config/environments/local.json
```

The same variable works with `publish.sh`. Only the packed archive enters the
container build context; the source checkout is not copied into this repo.

## Review and deploy

```bash
./scripts/test.sh
./scripts/synth.sh config/environments/local.json
./scripts/publish.sh config/environments/local.json
```

`publish.sh` checks Docker, runs all quality gates, displays `cdk diff`, and
deploys with approval required for IAM broadening. It writes a mode-0600
`remote-workers.json` from CloudFormation outputs. Lambda processing is not
operationally enabled until that file exists at
`<site-runtime>/remote-workers.json` on the coordinator host.

The generated file includes the DynamoDB progress table name. It contains no
AWS credentials. The exporter reads the table with the same temporary role it
already uses for Lambda invocation and S3 workspace access.

Install to a locally accessible runtime directory:

```bash
PUBLISHER_RUNTIME_DIR=/absolute/site/runtime \
  ./scripts/publish.sh config/environments/local.json
```

For a remote host, the second argument accepts an ordinary `scp` destination:

```bash
./scripts/publish.sh config/environments/local.json \
  ubuntu@example.com:/home/ubuntu/remote-workers.json
```

Then install it on that host with owner-only permissions. If the runtime
directory needs elevated privileges, upload to a controlled staging path first
and use `install -m 0600`; do not grant the SSH user broad write access to the
WordPress tree.

Verify all configured aliases from the coordinator host:

```bash
publisher-exporter remote-worker-health \
  --runtime-dir /absolute/site/runtime
```

## Task contract and idempotency boundary

For job `JOB` and task `TASK`, task-owned objects are stored below:

```text
<workspace-prefix>/jobs/JOB/tasks/TASK/
  pages/...
  result.json
```

`result.json` is a completed-result marker and replay shortcut. It is **not an
atomic claim, lease, or distributed lock**. Concurrent invocations with the
same task ID can both start work before either result exists. The coordinator
must prevent concurrent duplicate dispatch when that matters and must use
globally unique task IDs when a retry is intended to execute again. Lambda and
network delivery are at least once, so every caller must tolerate replay.

Deploy-copy accepts only explicit deletion keys in its task payload and never
infers deletions by listing a workspace or destination bucket. The worker
checks the configured target and prefix boundary; it does **not** prove that a
deletion list came from the correct crawl manifest. The coordinator is solely
responsible for manifest provenance, integrity, job/target association, and
for refusing stale or untrusted deletion payloads.

Current per-invocation limits are 1-20 same-origin render URLs, 1-20 asset
URLs, 500 rewrite objects, and 1000 deploy-copy objects. The exporter defaults
to five render URLs per invocation so one warm Chromium process can be reused
without increasing the simultaneous load on the origin. Increase batch sizes
only after duration, memory, and downstream capacity show adequate margin.

## Security and encryption limitations

The worker roles are separated by operation and scoped to the configured S3
prefixes. Render and asset are VPC-attached and share the selected subnet,
security-group, and proxy/NAT path. The asset role can read and write only the
workspace prefix and has no target-bucket permissions; target access remains
exclusive to deploy-copy. Configuration files must not contain secrets; proxy
credentials in `proxyUrl` are rejected. Keep proxy authentication in a
separately managed network layer.

New workspace buckets use S3-managed encryption, block public access, and
enforce TLS. This release does not provision a customer-managed KMS key or add
arbitrary `kms:Decrypt`, `kms:Encrypt`, or `kms:GenerateDataKey` grants. If an
imported workspace bucket, a deploy target, or its objects use SSE-KMS, the
operator must add narrowly scoped key-policy and role grants outside this
stack. Cross-account KMS keys need grants in both the key policy and worker
role. CloudWatch log groups likewise use AWS-managed encryption. Environments
that require customer-managed encryption for logs need a reviewed extension
before deployment.

Active X-Ray tracing records service metadata and sampled request paths. Do not
put secrets, authorization headers, full page bodies, or personal data in task
IDs, logs, trace annotations, or errors.

## Observability and cost controls

- Log retention is configurable from 1 to 365 days and defaults to 30.
- X-Ray active tracing is enabled on all four workers. X-Ray sampling and
  retention follow the account-level service configuration.
- Each alias has alarms for errors, throttles, and p99 duration over 80 percent
  of its timeout. They use two breaching points out of three one-minute periods
  and treat missing data as not breaching.
- The stack creates no SNS topic or alarm action. Route alarm state changes to
  your existing notification or incident-management system after deployment.

Primary costs are Lambda duration and memory, container image storage, NAT or
proxy traffic, S3 requests and storage, CloudWatch logs/alarms, and X-Ray
traces. Playwright rendering and asset transfer are normally the largest
Lambda costs. Reserved concurrency is a capacity reservation and safety
ceiling, not a per-job fan-out control or spending limit. Use AWS Budgets and
Cost Anomaly Detection, keep lifecycle and log retention finite, and monitor
NAT data processing when an S3 gateway endpoint is disabled.

## Retention and cleanup

When the stack creates the workspace bucket, it adds a lifecycle rule for only
the configured prefix. `workspace.lifecycleDays` defaults to 30. Imported
buckets are not modified, so their owner must provide an equivalent scoped
lifecycle policy. Never use broad bucket synchronization or deletion as a
cleanup mechanism.

`workspace.retainOnDelete` defaults to true. With that setting, destroying the
stack retains a stack-created bucket and its objects for recovery. When false,
CDK configures bucket and object deletion during stack removal; review the
exact bucket and prefix before choosing it. Lambda log groups are deleted with
the stack. Export or retain them separately if policy requires longer audit
history.

## Upgrade and rollback

1. Publish or select the exact exporter version and update
   `publisherExporterVersion`.
2. Run `npm ci`, `npm run check`, `npm run audit:prod`, and the strict synth.
3. Review `cdk diff`, especially IAM, VPC, bucket lifecycle, and replacement
   changes. Never rename constructs casually because logical-ID changes can
   replace resources.
4. Deploy, install the newly generated runtime config, and run the health
   command before enabling remote phases.
5. Watch alarms, logs, traces, and a bounded smoke publication.

CloudFormation rollback restores the previous Lambda alias target when a stack
update fails. For an application-level regression, set the previously known
exporter version in configuration and deploy that explicit version again. Do
not reuse a mutable container tag, hand-edit the alias, or use CDK hotswap in
production; those approaches create drift. Keep the previous
`remote-workers.json` only as controlled rollback material and verify that its
roles and aliases still exist before reinstalling it.

## Troubleshooting

- **Strict synth requests AWS credentials:** use `npm run synth:ci`. A real
  environment config uses VPC lookup and therefore needs credentials plus
  current `cdk.context.json` generated locally.
- **Docker or platform failure:** start the Docker daemon and enable buildx;
  set `workers.architecture` to match the required Lambda architecture.
- **Local exporter version mismatch:** update the checkout or the configured
  version. `PUBLISHER_EXPORTER_SOURCE_DIR` must point to the directory that
  contains the exporter's `package.json`.
- **Render timeouts:** verify proxy/NAT reachability, DNS, security-group
  egress, proxy ingress, and upstream response time before increasing timeout.
- **Asset timeouts or throttles:** verify the same egress path, then compare the
  WordPress job fan-out with `workers.assetConcurrency` and the account's
  available Lambda concurrency before raising the stack safety ceiling.
- **S3 access denied:** verify the workspace/target prefix, bucket policy,
  object ownership, Region, and SSE-KMS grants. A gateway endpoint policy can
  deny requests even when IAM allows them.
- **AssumeRole denied:** attach the generated caller policy or grant
  `sts:AssumeRole` through your IAM stack, then check both the caller policy and
  generated role trust policy.
- **Alarm has no notification:** alarms intentionally have no action. Connect
  them to your existing alerting route.
- **Unexpected duplicate work:** check coordinator dispatch and retry logic;
  `result.json` does not serialize concurrent invocations.

## Development and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request gates and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. This project is
available under the [MIT License](LICENSE).
