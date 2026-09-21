import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const exportConfigScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/export-config.mjs",
);

function outputs(assetFunctionArn?: string): Record<string, unknown> {
  return {
    StaticPublisherWorkers: {
      Region: "eu-central-1",
      WorkspaceBucket: "publisher-workspace",
      WorkspacePrefix: "publisher/dev/",
      RenderFunctionArn:
        "arn:aws:lambda:eu-central-1:123456789012:function:render:live",
      ...(assetFunctionArn ? { AssetFunctionArn: assetFunctionArn } : {}),
      RewriteFunctionArn:
        "arn:aws:lambda:eu-central-1:123456789012:function:rewrite:live",
      DeployFunctionArn:
        "arn:aws:lambda:eu-central-1:123456789012:function:deploy:live",
      ExporterAccessRoleArn: "arn:aws:iam::123456789012:role/exporter-access",
      ExporterCallerPolicyArn:
        "arn:aws:iam::123456789012:policy/exporter-caller",
      WorkerProtocolVersion: "1",
      DeploymentTargets: "[]",
      WorkerProgressTableName: "publisher-worker-progress",
    },
  };
}

describe("remote worker config export", () => {
  it("exports the asset live alias with owner-only permissions", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "publisher-export-config-"),
    );
    try {
      const outputsPath = path.join(directory, "outputs.json");
      const destinationPath = path.join(directory, "remote-workers.json");
      const assetFunctionArn =
        "arn:aws:lambda:eu-central-1:123456789012:function:asset:live";
      await writeFile(
        outputsPath,
        JSON.stringify(outputs(assetFunctionArn)),
        "utf8",
      );

      await execFileAsync(process.execPath, [
        exportConfigScript,
        "--outputs",
        outputsPath,
        "--destination",
        destinationPath,
      ]);

      const exported = JSON.parse(await readFile(destinationPath, "utf8")) as {
        functions: Record<string, string>;
        status: { tableName: string };
      };
      expect(exported.functions.asset).toBe(assetFunctionArn);
      expect(exported.status.tableName).toBe("publisher-worker-progress");
      expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects CDK outputs that omit the asset function", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "publisher-export-config-"),
    );
    try {
      const outputsPath = path.join(directory, "outputs.json");
      const destinationPath = path.join(directory, "remote-workers.json");
      await writeFile(outputsPath, JSON.stringify(outputs()), "utf8");

      await expect(
        execFileAsync(process.execPath, [
          exportConfigScript,
          "--outputs",
          outputsPath,
          "--destination",
          destinationPath,
        ]),
      ).rejects.toThrow(/Missing CDK output: AssetFunctionArn/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
