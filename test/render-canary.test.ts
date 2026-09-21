import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Observation = {
  logStream: string;
  tempUsedMiB: number;
  nodeRssMiB: number;
};
type Validators = {
  validateOutputs: (input: unknown, region?: string) => Record<string, string>;
  validateUrls: (origin: string, urls: unknown) => string[];
  validateResponse: (
    metadata: unknown,
    response: unknown,
    expected: unknown,
  ) => void;
  validatePages: (
    document: unknown,
    expected: string[],
    scope: unknown,
  ) => unknown[];
  validateHead: (head: unknown, reference: unknown) => void;
  parseDiagnostic: (message: string) => unknown;
  validateDiagnostics: (events: unknown[], requestId: string) => unknown;
  validateResourceTrend: (
    observations: Observation[],
    requireWarm?: boolean,
  ) => void;
};
const script = pathToFileURL(
  path.resolve("scripts/test-render-canary.mjs"),
).href;
const v = (await import(script)) as Validators;
const scope = { bucket: "canary-workspace", prefix: "render-canary/test/" };
const expected = {
  prefix: scope.prefix,
  jobId: "job",
  taskId: "task",
  urls: ["https://example.com/docs/"],
};
const metadata = { StatusCode: 200 };
const response = {
  schemaVersion: 1,
  operation: "render",
  jobId: "job",
  taskId: "task",
  status: "succeeded",
  completedItems: 1,
  failedItems: 0,
  resultKey: `${scope.prefix}result.json`,
};
const html = {
  ...scope,
  key: `${scope.prefix}page.html`,
  bytes: 12,
  contentType: "text/html; charset=utf-8",
};
const page = {
  requestedUrl: expected.urls[0],
  outcome: "rendered",
  httpStatus: 200,
  contentType: html.contentType,
  html,
};
function outputs(overrides = {}) {
  return {
    DemoRenderCanary: {
      Region: "eu-central-1",
      WorkspaceBucket: scope.bucket,
      WorkspacePrefix: scope.prefix,
      RenderFunctionArn:
        "arn:aws:lambda:eu-central-1:123456789012:function:canary:live",
      ...overrides,
    },
  };
}
function cleanup(overrides = {}) {
  return {
    logStreamName: "warm-stream",
    message: JSON.stringify({
      event: "invocation.cleanup-finished",
      requestId: "request",
      resources: {
        playwrightProfiles: { count: 0 },
        tempStorage: { usedMiB: 20, availableMiB: 2000 },
        processMemoryMiB: { rss: 100 },
      },
      ...overrides,
    }),
  };
}

describe("isolated render canary safeguards", () => {
  it("accepts only one canary stack with qualified render output and matching region", () => {
    expect(v.validateOutputs(outputs()).bucket).toBe(scope.bucket);
    expect(() =>
      v.validateOutputs({ Production: outputs().DemoRenderCanary }),
    ).toThrow(/RenderCanary/);
    expect(() =>
      v.validateOutputs(outputs({ WorkspacePrefix: "production/" })),
    ).toThrow(/render-canary/);
    expect(() =>
      v.validateOutputs(
        outputs({
          RenderFunctionArn:
            "arn:aws:lambda:eu-central-1:123456789012:function:canary",
        }),
      ),
    ).toThrow(/qualified/);
    expect(() => v.validateOutputs(outputs(), "us-east-1")).toThrow(/Region/);
    expect(() =>
      v.validateOutputs({ ...outputs(), AnotherRenderCanary: {} }),
    ).toThrow(/exactly one/);
  });

  it("rejects cross-origin or credential-bearing URLs", () => {
    expect(v.validateUrls("https://example.com", expected.urls)).toEqual(
      expected.urls,
    );
    for (const url of [
      "https://other.example/docs/",
      "https://user:pass@example.com/docs/",
      "https://example.com/?token=secret",
    ])
      expect(() => v.validateUrls("https://example.com", [url])).toThrow();
  });

  it("rejects Lambda errors, partial results, mismatched task IDs and out-of-scope keys", () => {
    expect(() =>
      v.validateResponse(metadata, response, expected),
    ).not.toThrow();
    expect(() =>
      v.validateResponse(
        { ...metadata, FunctionError: "Unhandled" },
        response,
        expected,
      ),
    ).toThrow(/invocation failed/);
    for (const change of [
      { failedItems: 1 },
      { status: "partial" },
      { taskId: "cached-task" },
      { completedItems: 0 },
      { resultKey: "production/result.json" },
    ])
      expect(() =>
        v.validateResponse(metadata, { ...response, ...change }, expected),
      ).toThrow();
  });

  it("checks every page outcome, HTTP status, HTML MIME, object scope and length", () => {
    expect(
      v.validatePages({ detail: { pages: [page] } }, expected.urls, scope),
    ).toHaveLength(1);
    for (const change of [
      { httpStatus: 404 },
      { outcome: "deferred" },
      { contentType: "text/plain" },
      { html: { ...html, bucket: "production" } },
      { html: { ...html, bytes: 0 } },
    ])
      expect(() =>
        v.validatePages(
          { detail: { pages: [{ ...page, ...change }] } },
          expected.urls,
          scope,
        ),
      ).toThrow();
    expect(() =>
      v.validateHead(
        { ContentLength: 12, ContentType: html.contentType },
        html,
      ),
    ).not.toThrow();
    expect(() =>
      v.validateHead({ ContentLength: 12, ContentType: "text/plain" }, html),
    ).toThrow();
    expect(() =>
      v.validateHead(
        { ContentLength: 11, ContentType: html.contentType },
        html,
      ),
    ).toThrow();
  });

  it("parses Lambda text and structured JSON diagnostics", () => {
    const diagnostic = { event: "invocation.cleanup-finished" };
    expect(
      v.parseDiagnostic(`date\trequest\tINFO\t${JSON.stringify(diagnostic)}`),
    ).toEqual(diagnostic);
    expect(
      v.parseDiagnostic(
        JSON.stringify({ message: JSON.stringify(diagnostic) }),
      ),
    ).toEqual(diagnostic);
    expect(v.parseDiagnostic("REPORT RequestId: abc")).toBeNull();
  });

  it("rejects failed cleanup, missing disk observations, failed pages and progress warnings", () => {
    expect(() => v.validateDiagnostics([cleanup()], "request")).not.toThrow();
    for (const diagnostic of [
      { event: "runtime.uncaught-exception" },
      { event: "browser.profile-cleanup-failed.after-close" },
      { event: "browser.disconnected", expected: false },
      { event: "render.page-finished", outcome: "failed" },
      { message: "Remote worker progress status could not be written." },
    ])
      expect(() =>
        v.validateDiagnostics(
          [cleanup(), { message: JSON.stringify(diagnostic) }],
          "request",
        ),
      ).toThrow();
    expect(() =>
      v.validateDiagnostics([cleanup({ resources: {} })], "request"),
    ).toThrow();
    expect(() =>
      v.validateDiagnostics([cleanup()], "different-request"),
    ).toThrow(/Missing/);
    expect(() =>
      v.validateDiagnostics(
        [
          cleanup(),
          {
            message: JSON.stringify({
              event: "browser.disconnected",
              expected: true,
            }),
          },
        ],
        "request",
      ),
    ).not.toThrow();
  });

  it("requires warm reuse and limits post-cleanup growth within each environment", () => {
    const baseline = { logStream: "one", tempUsedMiB: 20, nodeRssMiB: 100 };
    expect(() =>
      v.validateResourceTrend([baseline, baseline, baseline]),
    ).not.toThrow();
    expect(() =>
      v.validateResourceTrend([
        baseline,
        { ...baseline, logStream: "two" },
        { ...baseline, logStream: "three" },
      ]),
    ).toThrow(/same warm/);
    expect(() =>
      v.validateResourceTrend(
        [baseline, { ...baseline, tempUsedMiB: 53 }],
        false,
      ),
    ).toThrow(/32 MiB/);
    expect(() =>
      v.validateResourceTrend(
        [baseline, { ...baseline, nodeRssMiB: 229 }],
        false,
      ),
    ).toThrow(/128 MiB/);
    expect(() =>
      v.validateResourceTrend(
        [baseline, { ...baseline, logStream: "two", tempUsedMiB: 200 }],
        false,
      ),
    ).not.toThrow();
  });
});
