# Unpublished render canary

Use a separate `RenderCanary` stack to test working exporter changes without
publishing an npm version or changing the production worker aliases. A local
tarball retains its package version; its SHA-256 and the deployed image digest,
not that version string alone, identify the tested build.

## Mandatory final-image browser gate

Both `worker/npm/Dockerfile` and `worker/local/Dockerfile` use one exact
`PLAYWRIGHT_VERSION` build argument (currently `1.63.0`) for the build and
runtime base images. Their final stage runs `browser-smoke.mjs` after installing
the exporter. The script resolves Playwright from that exporter, rejects a
floating dependency or a mismatched installed `playwright`/`playwright-core`
version, checks the browser executable, then actually launches headless Chromium
with the exporter's `remoteBrowserLaunchOptions()` helper. It renders two local
HTML documents in fresh non-persistent contexts, verifies cookie isolation,
closes both contexts and the browser, and removes its owned temporary directory.
No WordPress, proxy, or AWS request is involved.

Before Chromium, the same final-image gate also loads the native
`aws-lambda-ric/rapid-client.node` module in
an isolated child process, supplying a loopback `AWS_LAMBDA_RUNTIME_API` only
to that child because RIC's native static initializer requires it. The probe
checks exports without calling the Runtime API; the placeholder is never
persisted in the image or worker environment. Both Docker contexts install RIC from
an identical private runtime manifest, approve only its pinned lifecycle scripts,
and override `http-cache-semantics` to the audited patched version. This catches
missing native build artifacts and ABI errors before an image reaches Lambda;
the production audit remains mandatory after installing the exporter.

Exporter 1.1.85 introduces the required exact dependency and launch-options
entry point. Updating Playwright requires changing the exporter pin and the
Docker argument together, then rerunning this image build and the Lambda canary.
Do not disable the smoke or override the executable to work around a failure.
The two script copies are intentional because the npm and local-tarball Docker
build contexts are independent; the repository test requires byte equality.

This is a Docker-build acceptance gate, not a source-only test. `npm test` and
`synth:ci` do not prove that it passes. Build the actual architecture used by the
render worker; an x86 image smoke cannot validate an ARM64 image. Even a passing
Docker smoke does not replace the VPC/proxy/IAM and resource-lifecycle checks in
an actual Lambda invocation below.

1. Run the exporter type, lint, unit, browser lifecycle, build, and dependency
   audit gates. The lifecycle test must use Chromium Headless Shell, not an
   explicit full-Chromium executable. Exporter 1.1.71 uses `--no-zygote`
   without `--single-process`, one non-persistent context per page, and browser
   shutdown plus owned temporary-file cleanup after each batch. Keep the test
   launch flags and browser binary aligned with the worker.
2. Save the production render function's `VpcConfig` and `Architectures` from
   `aws lambda get-function-configuration` into a private runtime JSON file.
3. Derive an isolated config:

   ```sh
   node scripts/prepare-canary-config.mjs --source config/environments/local.json --runtime .tmp/runtime.json --destination config/environments/canary.json --version 1.1.71
   node scripts/prepare-local-exporter.mjs config/environments/canary.json
   ```

   The helper refuses to overwrite files. The canary reuses the existing VPC,
   subnets and security groups, but creates its own workspace and progress
   table, has no deployment targets, and does not attach a WordPress caller
   policy or create endpoints/origin ingress. Check existing endpoint policies
   and route tables before deployment.

4. With Docker available, use `cdk synth`, `cdk diff`, then `cdk deploy` with
   `-c config=config/environments/canary.json`, a separate CDK output directory
   and a separate outputs JSON file. Never run the runtime-config installer.
5. Run actual render requests (URLs file is a JSON array of same-origin URLs):

   ```sh
   node scripts/test-render-canary.mjs --outputs .tmp/canary/outputs.json --source-origin https://source.example.com --urls .tmp/urls.json --batches 6 --batch-size 5
   ```

Each invocation uses a unique task ID so cached S3 results cannot bypass the
browser. The runner verifies HTML MIME and size, fails on worker diagnostics,
records post-cleanup disk/Node RSS and Lambda peak-memory reports, and requires
three invocations in the same CloudWatch stream. Node RSS is not total Chromium
memory. `sharedMemory` may report that `/dev/shm` does not exist; Chromium's
`--disable-dev-shm-usage` instead uses temporary-file-backed shared memory.

A passing local test is not a Lambda acceptance test. A passing short canary
is evidence for the measured workload, not proof that every resource can never
leak. Keep releases blocked on failed renders, cleanup, or growth checks.
The 1.1.71 release-candidate acceptance run rendered 62 pages over 11
invocations in one warm ARM64 Lambda environment. Lambda peak memory was
912 MiB of 4096 MiB, and post-cleanup temporary-storage usage was 16.05 MiB
after every invocation. These measurements describe that run, not a guarantee
for all pages or workloads.
Test objects expire after one day; the bucket is retained on stack deletion.
Do not delete production/shared prefixes when cleaning up test resources.
