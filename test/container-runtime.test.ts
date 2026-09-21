import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("worker container runtime", () => {
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
