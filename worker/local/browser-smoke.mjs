import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Keep this file byte-identical in worker/npm and worker/local: their Docker
// build contexts are intentionally independent.
const requireFromWorker = createRequire(import.meta.url);
const exporterPackagePath =
  process.env.PUBLISHER_EXPORTER_PACKAGE_PATH ??
  requireFromWorker.resolve("@smart-cloud/publisher-exporter/package.json");
const requireFromExporter = createRequire(exporterPackagePath);
const expectedVersion = process.env.PLAYWRIGHT_VERSION;
assert.match(
  expectedVersion ?? "",
  /^\d+\.\d+\.\d+$/,
  "PLAYWRIGHT_VERSION must be the exact version used by the Docker base image",
);
const exporterPackage = JSON.parse(await readFile(exporterPackagePath, "utf8"));
assert.equal(
  exporterPackage.dependencies?.playwright,
  expectedVersion,
  "Exporter Playwright dependency must be pinned exactly to the Docker base image",
);
const playwrightPackagePath = requireFromExporter.resolve(
  "playwright/package.json",
);
const requireFromPlaywright = createRequire(playwrightPackagePath);
for (const [packageName, packagePath] of [
  ["playwright", playwrightPackagePath],
  [
    "playwright-core",
    requireFromPlaywright.resolve("playwright-core/package.json"),
  ],
]) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(
    packageJson.version,
    expectedVersion,
    `${packageName} installed version differs from the Docker base image`,
  );
}

// Resolve from the exporter rather than accidentally validating another
// Playwright installation. Import the same launch options used by its worker.
// Loading the native binding also fails the build when npm skipped the pinned
// RIC install script or compiled it for an incompatible architecture.
requireFromWorker("aws-lambda-ric/rapid-client.node");
const { chromium } = requireFromExporter("playwright");
const { remoteBrowserLaunchOptions } = await import(
  pathToFileURL(
    path.join(path.dirname(exporterPackagePath), "dist/browser-launch.js"),
  ).href
);
await access(chromium.executablePath());
const smokeTemp = await mkdtemp(
  path.join(os.tmpdir(), "publisher-browser-smoke-"),
);
const priorTmpdir = process.env.TMPDIR;
process.env.TMPDIR = smokeTemp;
let browser;
let chromiumVersion;
try {
  browser = await chromium.launch({
    ...remoteBrowserLaunchOptions(),
    timeout: 30_000,
  });
  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    const context = await browser.newContext();
    try {
      assert.deepEqual(
        await context.cookies(),
        [],
        "Fresh context leaked cookies",
      );
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><title>Worker smoke ${pageIndex}</title><main>Rendered ${pageIndex}</main>`,
        { timeout: 10_000 },
      );
      assert.equal(await page.title(), `Worker smoke ${pageIndex}`);
      assert.equal(
        await page.locator("main").innerText(),
        `Rendered ${pageIndex}`,
      );
      await context.addCookies([
        {
          name: "smoke",
          value: String(pageIndex),
          url: "https://smoke.invalid/",
        },
      ]);
      assert.equal((await context.cookies()).length, 1);
    } finally {
      await context.close();
    }
  }
  chromiumVersion = browser.version();
} finally {
  try {
    await browser?.close();
  } finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    await rm(smokeTemp, { recursive: true, force: true });
  }
}
console.log(
  `Worker browser smoke passed: exporter ${exporterPackage.version}, Playwright ${expectedVersion}, Chromium ${chromiumVersion}, two isolated contexts and cleanup`,
);
