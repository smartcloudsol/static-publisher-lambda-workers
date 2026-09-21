# Unpublished render canary

Use a separate `RenderCanary` stack to test working exporter changes without
publishing an npm version or changing the production worker aliases. A local
tarball retains its package version; its SHA-256 and the deployed image digest,
not that version string alone, identify the tested build.

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
