import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateOutputs(document, requestedRegion) {
  const entries = Object.entries(document);
  requireValue(
    entries.length === 1,
    "Expected exactly one canary stack output.",
  );
  const [stack, output] = entries[0];
  requireValue(
    stack.endsWith("RenderCanary"),
    "Stack must end in RenderCanary.",
  );
  requireValue(
    output.WorkspacePrefix?.startsWith("render-canary/"),
    "Workspace must use render-canary/.",
  );
  requireValue(
    output.WorkspacePrefix.endsWith("/") &&
      !output.WorkspacePrefix.includes(".."),
    "Invalid canary prefix.",
  );
  requireValue(
    typeof output.WorkspaceBucket === "string" &&
      output.WorkspaceBucket.length > 0,
    "Missing workspace bucket.",
  );
  const arn =
    /^arn:[a-z-]+:lambda:([a-z0-9-]+):\d{12}:function:([^:]+):([a-zA-Z0-9_-]+)$/.exec(
      output.RenderFunctionArn ?? "",
    );
  requireValue(
    arn && arn[3] !== "$LATEST",
    "Render output must be a qualified Lambda ARN.",
  );
  requireValue(
    output.Region === arn[1] &&
      (!requestedRegion || requestedRegion === output.Region),
    "Region does not match stack output.",
  );
  return {
    stack,
    region: output.Region,
    bucket: output.WorkspaceBucket,
    prefix: output.WorkspacePrefix,
    functionArn: output.RenderFunctionArn,
  };
}

export function validateUrls(sourceOrigin, urls) {
  const origin = new URL(sourceOrigin);
  requireValue(
    ["https:", "http:"].includes(origin.protocol) &&
      !origin.username &&
      !origin.password,
    "Invalid source origin.",
  );
  requireValue(
    Array.isArray(urls) && urls.length > 0,
    "URLs file must contain a nonempty JSON array.",
  );
  return urls.map((value) => {
    requireValue(typeof value === "string", "URL must be a string.");
    const url = new URL(value);
    requireValue(
      url.origin === origin.origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "URLs must share source origin and contain no credentials, query, or fragment.",
    );
    return url.toString();
  });
}

export function validateResponse(metadata, response, expected) {
  requireValue(
    !metadata.FunctionError && metadata.StatusCode === 200,
    "Lambda invocation failed.",
  );
  requireValue(
    response.schemaVersion === 1 &&
      response.operation === "render" &&
      response.jobId === expected.jobId &&
      response.taskId === expected.taskId,
    "Response identity mismatch.",
  );
  requireValue(
    response.status === "succeeded" &&
      response.failedItems === 0 &&
      response.completedItems === expected.urls.length,
    "Render task was not fully successful.",
  );
  requireValue(
    typeof response.resultKey === "string" &&
      response.resultKey.startsWith(expected.prefix) &&
      !response.resultKey.includes(".."),
    "Result key is outside canary workspace.",
  );
}

export function validatePages(document, expected, scope) {
  const pages = document.detail?.pages;
  requireValue(
    Array.isArray(pages) && pages.length === expected.length,
    "Missing rendered pages.",
  );
  for (const [index, page] of pages.entries()) {
    requireValue(
      page.requestedUrl === expected[index] &&
        page.outcome === "rendered" &&
        page.httpStatus >= 200 &&
        page.httpStatus < 300,
      "Page did not render with HTTP 2xx.",
    );
    requireValue(
      /^text\/html(?:\s*;|$)/i.test(page.contentType ?? ""),
      "Page MIME is not text/html.",
    );
    requireValue(
      page.html?.bucket === scope.bucket &&
        page.html.key?.startsWith(scope.prefix) &&
        !page.html.key.includes(".."),
      "HTML object is outside canary workspace.",
    );
    requireValue(
      Number.isInteger(page.html.bytes) &&
        page.html.bytes > 0 &&
        page.html.contentType === page.contentType,
      "Invalid HTML object metadata.",
    );
  }
  return pages.map((page) => page.html);
}

export function validateHead(head, reference) {
  requireValue(
    head.ContentType === reference.contentType &&
      head.ContentLength === reference.bytes,
    "Stored HTML MIME or length mismatch.",
  );
}

export function parseDiagnostic(message) {
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(start));
    if (typeof parsed.message === "string" && parsed.message.startsWith("{"))
      return JSON.parse(parsed.message);
    return parsed;
  } catch {
    return null;
  }
}

export function validateDiagnostics(events, requestId) {
  const matched = events.map((entry) => ({
    ...entry,
    diagnostic: parseDiagnostic(entry.message),
  }));
  for (const entry of matched) {
    const d = entry.diagnostic;
    if (!d) continue;
    requireValue(
      !/progress status could not be written/i.test(d.message ?? ""),
      "Progress status write failed.",
    );
    requireValue(
      !/uncaught|failed|browser-closed/.test(d.event ?? "") &&
        !(d.event === "browser.disconnected" && d.expected !== true) &&
        !["failed", "deferred", "http-error"].includes(d.outcome),
      "Worker emitted a failure diagnostic.",
    );
  }
  const cleanup = matched.find(
    ({ diagnostic: d }) =>
      d?.requestId === requestId && d.event === "invocation.cleanup-finished",
  );
  requireValue(cleanup, "Missing invocation.cleanup-finished diagnostic.");
  const resources = cleanup.diagnostic.resources;
  requireValue(
    resources?.playwrightProfiles?.count === 0,
    "Browser profiles remain after cleanup.",
  );
  const { usedMiB, availableMiB } = resources.tempStorage ?? {};
  const rss = resources.processMemoryMiB?.rss;
  requireValue(
    Number.isFinite(usedMiB) &&
      usedMiB >= 0 &&
      Number.isFinite(availableMiB) &&
      availableMiB > 0 &&
      Number.isFinite(rss) &&
      rss > 0,
    "Missing or exhausted cleanup resource measurements.",
  );
  requireValue(
    typeof cleanup.logStreamName === "string" &&
      cleanup.logStreamName.length > 0,
    "Missing CloudWatch log stream.",
  );
  return {
    requestId,
    logStream: cleanup.logStreamName,
    tempUsedMiB: usedMiB,
    tempAvailableMiB: availableMiB,
    nodeRssMiB: rss,
    sharedMemory: resources.sharedMemory,
    profiles: 0,
  };
}

export function validateResourceTrend(observations, requireWarm = true) {
  const groups = new Map();
  for (const observation of observations) {
    const group = groups.get(observation.logStream) ?? [];
    group.push(observation);
    groups.set(observation.logStream, group);
    requireValue(
      observation.tempUsedMiB - group[0].tempUsedMiB <= 32,
      "Post-cleanup /tmp growth exceeded 32 MiB within one environment.",
    );
    requireValue(
      observation.nodeRssMiB - group[0].nodeRssMiB <= 128,
      "Post-cleanup Node RSS growth exceeded 128 MiB within one environment.",
    );
  }
  if (requireWarm)
    requireValue(
      [...groups.values()].some((group) => group.length >= 3),
      "Three invocations in the same warm environment were not demonstrated.",
    );
}

function cli(region, args) {
  const result = spawnSync(
    "aws",
    [...args, "--region", region, "--output", "json", "--no-cli-pager"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 930_000 },
  );
  requireValue(
    !result.error && result.status === 0,
    `AWS CLI ${args[0]} ${args[1]} failed; output withheld to avoid leaking response bodies.`,
  );
  return JSON.parse(result.stdout || "{}");
}

async function logsForRequest(region, group, requestId, taskId, startTime) {
  for (let attempt = 0; attempt < 13; attempt += 1) {
    const response = cli(region, [
      "logs",
      "filter-log-events",
      "--log-group-name",
      group,
      "--start-time",
      String(startTime),
      "--filter-pattern",
      `"${taskId}"`,
    ]);
    const events = response.events ?? [];
    if (
      events.some((entry) => {
        const d = parseDiagnostic(entry.message);
        return (
          d?.requestId === requestId &&
          d.event === "invocation.cleanup-finished"
        );
      })
    )
      return events;
    if (attempt < 12) await delay(5000);
  }
  throw new Error(
    "Cleanup diagnostic did not arrive in CloudWatch within 60 seconds.",
  );
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  const allowed = new Set([
    "outputs",
    "source-origin",
    "urls",
    "batches",
    "batch-size",
    "region",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    requireValue(
      args[index]?.startsWith("--") &&
        allowed.has(key) &&
        args[index + 1] &&
        !options[key],
      "Invalid or duplicate CLI option.",
    );
    options[key] = args[index + 1];
  }
  requireValue(
    options.outputs && options["source-origin"] && options.urls,
    "Required: --outputs FILE --source-origin URL --urls FILE [--batches 6 --batch-size 5 --region REGION].",
  );
  const reportPath = path.join(
    path.dirname(path.resolve(options.outputs)),
    "canary-report.json",
  );
  const report = {
    status: "running",
    startedAt: new Date().toISOString(),
    observations: [],
    limits: {
      tempGrowthMiB: 32,
      nodeRssGrowthMiB: 128,
      minimumWarmInvocations: 3,
    },
    scope:
      "Render-only; Node RSS and /tmp observations do not prove the absence of all resource leaks.",
  };
  try {
    const scope = validateOutputs(
      JSON.parse(await readFile(options.outputs, "utf8")),
      options.region,
    );
    const urls = validateUrls(
      options["source-origin"],
      JSON.parse(await readFile(options.urls, "utf8")),
    );
    const batches = Number(options.batches ?? 6);
    const batchSize = Number(options["batch-size"] ?? 5);
    requireValue(
      Number.isInteger(batches) &&
        batches >= 3 &&
        batches <= 20 &&
        Number.isInteger(batchSize) &&
        batchSize >= 1 &&
        batchSize <= 20,
      "batches must be 3..20 and batch-size 1..20.",
    );
    const stackResources = cli(scope.region, [
      "cloudformation",
      "list-stack-resources",
      "--stack-name",
      scope.stack,
    ]);
    requireValue(
      stackResources.StackResourceSummaries?.some(
        (resource) =>
          resource.ResourceType === "AWS::Lambda::Function" &&
          resource.PhysicalResourceId === scope.functionArn.split(":")[6],
      ),
      "Render Lambda does not belong to the isolated canary stack.",
    );
    const logGroup = cli(scope.region, [
      "lambda",
      "get-function-configuration",
      "--function-name",
      scope.functionArn,
      "--query",
      "LoggingConfig.LogGroup",
    ]);
    requireValue(
      typeof logGroup === "string" && logGroup.length > 0,
      "Lambda did not provide its log group.",
    );
    const directory = await mkdtemp(
      path.join(tmpdir(), "publisher-render-canary-"),
    );
    report.stack = scope.stack;
    report.artifactsDirectory = directory;
    report.jobId = `canary-${randomUUID()}`;
    for (let index = 0; index <= batches; index += 1) {
      const taskId = `render-${index}-${randomUUID()}`;
      const taskUrls = Array.from(
        { length: index === 0 ? 1 : batchSize },
        (_, offset) =>
          urls[((Math.max(1, index) - 1) * batchSize + offset) % urls.length],
      );
      const event = {
        schemaVersion: 1,
        operation: "render",
        jobId: report.jobId,
        taskId,
        sourceOrigin: new URL(options["source-origin"]).origin,
        urls: taskUrls,
        options: {
          ignoreHttpsErrors: false,
          javaScriptEnabled: true,
          viewport: { width: 1440, height: 900 },
          navigationTimeoutMs: 45000,
          autoScrollTimeoutMs: 2000,
          readiness: {
            waitForSelector: "body",
            waitForFunction: null,
            timeoutMs: 10000,
            fallbackWaitMs: 500,
          },
        },
      };
      const payloadPath = path.join(directory, `request-${index}.json`);
      const responsePath = path.join(directory, `response-${index}.json`);
      await writeFile(payloadPath, JSON.stringify(event), { mode: 0o600 });
      const startTime = Date.now() - 1000;
      const metadata = cli(scope.region, [
        "lambda",
        "invoke",
        "--function-name",
        scope.functionArn,
        "--cli-binary-format",
        "raw-in-base64-out",
        "--payload",
        `file://${payloadPath}`,
        "--log-type",
        "Tail",
        "--cli-read-timeout",
        "900",
        responsePath,
      ]);
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      const tail = Buffer.from(metadata.LogResult ?? "", "base64").toString(
        "utf8",
      );
      const requestId =
        /(?:START|END|REPORT) RequestId:\s*([0-9a-f-]{36})/i.exec(tail)?.[1] ??
        tail
          .split("\n")
          .map(parseDiagnostic)
          .find((entry) => entry?.requestId)?.requestId;
      report.currentInvocation = {
        index,
        taskId,
        requestId: requestId ?? null,
        functionError: metadata.FunctionError ?? null,
        lambdaMaxMemoryUsedMiB:
          Number(/Max Memory Used:\s*(\d+) MB/.exec(tail)?.[1]) || null,
      };
      await writeFile(reportPath, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      requireValue(
        requestId,
        "Cannot correlate Lambda invocation with CloudWatch request ID.",
      );
      const events = await logsForRequest(
        scope.region,
        logGroup,
        requestId,
        taskId,
        startTime,
      );
      const observation = validateDiagnostics(events, requestId);
      report.observations.push({
        ...observation,
        lambdaMaxMemoryUsedMiB: report.currentInvocation.lambdaMaxMemoryUsedMiB,
        taskId,
        pageCount: taskUrls.length,
      });
      validateResourceTrend(report.observations, false);
      validateResponse(metadata, response, { ...event, prefix: scope.prefix });
      const detailPath = path.join(directory, `result-${index}.json`);
      cli(scope.region, [
        "s3api",
        "get-object",
        "--bucket",
        scope.bucket,
        "--key",
        response.resultKey,
        detailPath,
      ]);
      const document = JSON.parse(await readFile(detailPath, "utf8"));
      requireValue(
        document.requestId === requestId,
        "Stored result request ID mismatch.",
      );
      validateResponse(metadata, document.response, {
        ...event,
        prefix: scope.prefix,
      });
      for (const reference of validatePages(document, taskUrls, scope))
        validateHead(
          cli(scope.region, [
            "s3api",
            "head-object",
            "--bucket",
            scope.bucket,
            "--key",
            reference.key,
          ]),
          reference,
        );
      console.log(
        `Canary invocation ${index + 1}/${batches + 1}: ${taskUrls.length} pages; /tmp ${observation.tempUsedMiB} MiB; Node RSS ${observation.nodeRssMiB} MiB.`,
      );
      await writeFile(reportPath, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
    }
    validateResourceTrend(report.observations);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    console.log(`Canary report: ${reportPath}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
