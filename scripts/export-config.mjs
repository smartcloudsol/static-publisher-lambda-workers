#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(name, fallback) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const outputsPath = path.resolve(argument("--outputs", "cdk-outputs.json"));
const destinationPath = path.resolve(
  argument("--destination", "remote-workers.json"),
);
const outputsDocument = JSON.parse(await readFile(outputsPath, "utf8"));
const stackEntries = Object.entries(outputsDocument);
if (stackEntries.length !== 1) {
  throw new Error(
    `Expected exactly one stack in ${outputsPath}, found ${stackEntries.length}.`,
  );
}
const [, outputs] = stackEntries[0];
const required = [
  "Region",
  "WorkspaceBucket",
  "WorkspacePrefix",
  "RenderFunctionArn",
  "AssetFunctionArn",
  "RewriteFunctionArn",
  "DeployFunctionArn",
  "ExporterAccessRoleArn",
  "ExporterCallerPolicyArn",
  "WorkerProtocolVersion",
  "DeploymentTargets",
  "WorkerProgressTableName",
];
for (const name of required) {
  if (typeof outputs[name] !== "string") {
    throw new Error(`Missing CDK output: ${name}.`);
  }
}
const config = {
  schemaVersion: 1,
  region: outputs.Region,
  roleArn: outputs.ExporterAccessRoleArn,
  roleSessionName: "wpsuite-static-publisher",
  workspace: {
    bucket: outputs.WorkspaceBucket,
    prefix: outputs.WorkspacePrefix,
  },
  status: {
    tableName: outputs.WorkerProgressTableName,
  },
  functions: {
    render: outputs.RenderFunctionArn,
    asset: outputs.AssetFunctionArn,
    rewrite: outputs.RewriteFunctionArn,
    "deploy-copy": outputs.DeployFunctionArn,
  },
  targets: JSON.parse(outputs.DeploymentTargets),
  protocolVersion: Number(outputs.WorkerProtocolVersion),
};
await writeFile(destinationPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(destinationPath, 0o600);
