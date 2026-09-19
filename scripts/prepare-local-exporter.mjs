#!/usr/bin/env node

import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const infrastructureDir = path.resolve(import.meta.dirname, "..");
const configPath = path.resolve(
  infrastructureDir,
  process.argv[2] ??
    process.env.PUBLISHER_INFRA_CONFIG ??
    "config/environments/local.json",
);
const config = JSON.parse(await readFile(configPath, "utf8"));

if (config.publisherExporterSource !== "local-tarball") {
  process.exit(0);
}

const exporterDir = path.resolve(
  infrastructureDir,
  process.env.PUBLISHER_EXPORTER_SOURCE_DIR ?? "../static-publisher/exporter",
);
const packageJson = JSON.parse(
  await readFile(path.join(exporterDir, "package.json"), "utf8"),
);
if (packageJson.version !== config.publisherExporterVersion) {
  throw new Error(
    `Local exporter version ${packageJson.version} does not match configured version ${config.publisherExporterVersion}.`,
  );
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "wpsuite-publisher-exporter-"),
);
try {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--pack-destination", temporaryDirectory],
    {
      cwd: exporterDir,
      env: {
        ...process.env,
        npm_config_cache: path.join(infrastructureDir, ".tmp/npm-cache"),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack failed with exit code ${result.status ?? 1}.`);
  }

  const archiveName = `${String(packageJson.name)
    .replace(/^@/, "")
    .replaceAll("/", "-")}-${packageJson.version}.tgz`;
  const destination = path.join(
    infrastructureDir,
    "worker/local/publisher-exporter.tgz",
  );
  await copyFile(path.join(temporaryDirectory, archiveName), destination);
  console.log(`Prepared local exporter image input: ${destination}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
