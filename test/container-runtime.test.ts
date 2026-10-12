import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("worker container runtime", () => {
  it("keeps the native RIC compile layer cached across exporter version changes", async () => {
    const dockerfile = await readFile(
      path.join(projectRoot, "worker/npm/Dockerfile"),
      "utf8",
    );
    const exporterArg = dockerfile.indexOf("ARG PUBLISHER_EXPORTER_VERSION");
    expect(exporterArg).toBeGreaterThan(
      dockerfile.indexOf("npm cache clean --force"),
    );
    expect(exporterArg).toBeLessThan(
      dockerfile.indexOf('RUN test -n "$PUBLISHER_EXPORTER_VERSION"'),
    );
  });

  it("keeps both independent runtime dependency scaffolds identical and securely pinned", async () => {
    const npmScaffold = await readFile(
      path.join(projectRoot, "worker/npm/runtime-package.json"),
      "utf8",
    );
    expect(npmScaffold).toBe(
      await readFile(
        path.join(projectRoot, "worker/local/runtime-package.json"),
        "utf8",
      ),
    );
    expect(JSON.parse(npmScaffold)).toEqual({
      name: "static-publisher-worker-runtime",
      private: true,
      dependencies: { "aws-lambda-ric": "4.0.2" },
      overrides: { "http-cache-semantics": "4.3.0" },
      allowScripts: { "aws-lambda-ric@4.0.2": true },
    });
  });

  it.each(["npm", "local"])(
    "%s checks the native Lambda runtime and includes its build inputs in the public mirror",
    async (source) => {
      const script = await readFile(
        path.join(projectRoot, `worker/${source}/browser-smoke.mjs`),
        "utf8",
      );
      expect(script).toContain(
        'requireFromWorker("aws-lambda-ric/rapid-client.node")',
      );
      expect(
        script.indexOf('requireFromWorker("aws-lambda-ric/rapid-client.node")'),
      ).toBeGreaterThan(script.indexOf("installed version differs"));
      const dockerfile = await readFile(
        path.join(projectRoot, `worker/${source}/Dockerfile`),
        "utf8",
      );
      expect(dockerfile).toContain(
        "COPY runtime-package.json /var/task/package.json",
      );
      expect(dockerfile).not.toContain("npm init");
      const publicFiles = (
        await readFile(
          path.join(projectRoot, "config/github-public-files.txt"),
          "utf8",
        )
      ).split("\n");
      expect(publicFiles).toContain(`worker/${source}/browser-smoke.mjs`);
      expect(publicFiles).toContain(`worker/${source}/runtime-package.json`);
    },
  );

  it("keeps both independent Docker smoke scripts byte-identical", async () => {
    expect(
      await readFile(
        path.join(projectRoot, "worker/npm/browser-smoke.mjs"),
        "utf8",
      ),
    ).toBe(
      await readFile(
        path.join(projectRoot, "worker/local/browser-smoke.mjs"),
        "utf8",
      ),
    );
  });

  it.each(["npm", "local"])(
    "%s uses one browser version for both stages and runs the smoke in the final image",
    async (source) => {
      const dockerfile = await readFile(
        path.join(projectRoot, `worker/${source}/Dockerfile`),
        "utf8",
      );
      expect(dockerfile).toMatch(/^ARG PLAYWRIGHT_VERSION=1\.63\.0\n/);
      expect(
        dockerfile.match(
          /FROM mcr\.microsoft\.com\/playwright:v\$\{PLAYWRIGHT_VERSION\}-noble/g,
        ),
      ).toHaveLength(2);
      expect(dockerfile).toContain("PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}");
      const finalStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
      expect(finalStage).toContain(
        "COPY browser-smoke.mjs /var/task/browser-smoke.mjs",
      );
      expect(finalStage).toContain("RUN node /var/task/browser-smoke.mjs");
      expect(finalStage.indexOf("RUN node")).toBeGreaterThan(
        finalStage.indexOf("COPY --from=build"),
      );
    },
  );

  it.each([
    {
      dependency: "^1.63.0",
      installed: "1.63.0",
      expected: "1.63.0",
      error: "must be pinned exactly",
    },
    {
      dependency: "1.63.0",
      installed: "1.64.0",
      expected: "1.63.0",
      error: "installed version differs",
    },
    {
      dependency: "1.63.0",
      installed: "1.63.0",
      expected: "latest",
      error: "must be the exact version",
    },
  ])(
    "rejects an incompatible runtime before browser launch: $dependency / $installed / $expected",
    async ({ dependency, installed, expected, error }) => {
      const fixture = await mkdtemp(
        path.join(os.tmpdir(), "worker-version-guard-"),
      );
      try {
        await writeFile(
          path.join(fixture, "package.json"),
          JSON.stringify({ dependencies: { playwright: dependency } }),
        );
        for (const packageName of ["playwright", "playwright-core"]) {
          const packageDirectory = path.join(
            fixture,
            "node_modules",
            packageName,
          );
          await mkdir(packageDirectory, { recursive: true });
          await writeFile(
            path.join(packageDirectory, "package.json"),
            JSON.stringify({ version: installed, main: "index.js" }),
          );
          await writeFile(
            path.join(packageDirectory, "index.js"),
            'throw new Error("BROWSER_LAUNCH_MUST_NOT_RUN");',
          );
        }
        const result = spawnSync(
          process.execPath,
          [path.join(projectRoot, "worker/npm/browser-smoke.mjs")],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PLAYWRIGHT_VERSION: expected,
              PUBLISHER_EXPORTER_PACKAGE_PATH: path.join(
                fixture,
                "package.json",
              ),
            },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
        expect(result.stderr).not.toContain("BROWSER_LAUNCH_MUST_NOT_RUN");
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each(["npm", "local"])(
    "%s reserves a private writable root for Chromium without moving the Lambda runtime",
    async (source) => {
      const dockerfile = await readFile(
        path.join(projectRoot, `worker/${source}/Dockerfile`),
        "utf8",
      );

      expect(dockerfile).toContain(
        "PUBLISHER_BROWSER_TEMP_ROOT=/tmp/wpsuite-publisher-browser",
      );
      expect(dockerfile).toMatch(/HOME=\/tmp \\\n\s+TMPDIR=\/tmp/);
      expect(dockerfile).toContain(
        "NPM_CONFIG_CACHE=/tmp/wpsuite-publisher-runtime/npm",
      );
      expect(dockerfile).not.toContain("HOME=/tmp/wpsuite-publisher-browser");
    },
  );
});
