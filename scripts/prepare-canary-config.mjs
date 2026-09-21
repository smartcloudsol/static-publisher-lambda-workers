#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const semanticVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value;
}

function resourceId(value, kind) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${kind}-[0-9a-f]{8}(?:[0-9a-f]{9})?$`).test(value)
  ) {
    throw new Error(`Runtime configuration requires a valid ${kind} ID.`);
  }
  return value;
}

function resourceIds(value, kind) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Runtime configuration requires nonempty ${kind} IDs.`);
  }
  const ids = value.map((id) => resourceId(id, kind));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Runtime configuration contains duplicate ${kind} IDs.`);
  }
  return ids;
}

/** Derive an isolated stack without mutating either supplied JSON document. */
export function deriveCanaryConfig(source, runtime, version) {
  object(source, "Infrastructure configuration");
  object(runtime, "Runtime configuration");
  const network = object(source.network, "Infrastructure network");
  const deployedVpc = object(runtime.VpcConfig, "Runtime VpcConfig");
  if (typeof version !== "string" || !semanticVersion.test(version)) {
    throw new Error("Canary version must be an explicit semantic version.");
  }
  const originalStackName = source.stackName ?? "WpSuiteStaticPublisherWorkers";
  const stackName = `${originalStackName}RenderCanary`;
  if (
    typeof originalStackName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)
  ) {
    throw new Error(
      "Derived canary stack name must contain at most 128 letters, digits, or hyphens and start with a letter.",
    );
  }
  const vpcId = resourceId(deployedVpc.VpcId, "vpc");
  if (network.vpcId !== undefined && network.vpcId !== vpcId) {
    throw new Error("Source VPC does not match the deployed Lambda VPC.");
  }
  if (network.vpcId === undefined && network.useDefaultVpc !== true) {
    throw new Error("Source must select its VPC or the default VPC.");
  }
  if (
    !Array.isArray(runtime.Architectures) ||
    runtime.Architectures.length !== 1 ||
    !["arm64", "x86_64"].includes(runtime.Architectures[0])
  ) {
    throw new Error(
      "Runtime must identify exactly one supported architecture.",
    );
  }
  return {
    ...source,
    stackName,
    publisherExporterSource: "local-tarball",
    publisherExporterVersion: version,
    attachCallerPolicy: false,
    targets: [],
    workspace: {
      prefix: "render-canary/",
      lifecycleDays: 1,
      retainOnDelete: true,
    },
    network: {
      ...network,
      vpcId,
      useDefaultVpc: false,
      subnetIds: resourceIds(deployedVpc.SubnetIds, "subnet"),
      securityGroupIds: resourceIds(deployedVpc.SecurityGroupIds, "sg"),
      manageOriginIngress: false,
      createS3GatewayEndpoint: false,
      createDynamoDbGatewayEndpoint: false,
      s3GatewayEndpointRouteTableIds: [],
    },
    workers: {
      ...source.workers,
      architecture: runtime.Architectures[0],
      renderConcurrency: 1,
      assetConcurrency: 1,
      rewriteConcurrency: 1,
      deployConcurrency: 1,
      logRetentionDays: "1",
    },
  };
}

async function main() {
  const allowed = new Set([
    "--source",
    "--destination",
    "--runtime",
    "--version",
  ]);
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (
      !allowed.has(key) ||
      args.has(key) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(`Unexpected, duplicate, or incomplete argument: ${key}.`);
    }
    args.set(key, value);
  }
  for (const key of allowed) {
    if (!args.has(key)) throw new Error(`Missing required argument: ${key}.`);
  }
  const sourcePath = path.resolve(args.get("--source"));
  const runtimePath = path.resolve(args.get("--runtime"));
  const destinationPath = path.resolve(args.get("--destination"));
  if (destinationPath === sourcePath || destinationPath === runtimePath) {
    throw new Error("Canary configuration must not overwrite an input file.");
  }
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const config = deriveCanaryConfig(source, runtime, args.get("--version"));
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  // Exclusive creation also refuses symlink/hardlink aliases of either input.
  await writeFile(destinationPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(`Prepared isolated canary configuration at ${destinationPath}.`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
