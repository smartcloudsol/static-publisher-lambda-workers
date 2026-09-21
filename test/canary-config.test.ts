import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { infrastructureConfigSchema } from "../config/schema.js";

const script = path.resolve(
  import.meta.dirname,
  "../scripts/prepare-canary-config.mjs",
);
const source = {
  schemaVersion: 1,
  stackName: "PublisherProduction",
  account: "123456789012",
  region: "eu-central-1",
  callerRoleArn: "arn:aws:iam::123456789012:role/wordpress",
  attachCallerPolicy: true,
  publisherExporterSource: "npm",
  publisherExporterVersion: "1.1.70",
  network: {
    vpcId: "vpc-0123456789abcdef0",
    subnetIds: ["subnet-11111111"],
    securityGroupIds: ["sg-11111111"],
    originSecurityGroupId: "sg-22222222",
    manageOriginIngress: true,
    renderEgress: "proxy",
    proxyUrl: "http://192.0.2.1:3128",
    proxyPort: 3128,
    createS3GatewayEndpoint: true,
    createDynamoDbGatewayEndpoint: true,
    s3GatewayEndpointRouteTableIds: ["rtb-12345678"],
  },
  workspace: { bucketName: "production-workspace", prefix: "production/" },
  targets: [
    {
      id: "prod",
      bucketName: "production-site",
      prefix: "www/",
      region: "eu-central-1",
    },
  ],
  workers: {
    architecture: "x86_64",
    renderMemoryMiB: 4096,
    renderConcurrency: 4,
  },
};
const runtime = {
  VpcConfig: {
    VpcId: "vpc-0123456789abcdef0",
    SubnetIds: ["subnet-aaaaaaaa", "subnet-bbbbbbbb"],
    SecurityGroupIds: ["sg-aaaaaaaa"],
  },
  Architectures: ["arm64"],
};
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(config: unknown = source, deployed: unknown = runtime) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "publisher-canary-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "source.json");
  const runtimePath = path.join(directory, "runtime.json");
  const destination = path.join(directory, "out/config.json");
  writeFileSync(sourcePath, JSON.stringify(config));
  writeFileSync(runtimePath, JSON.stringify(deployed));
  const args = [
    "--source",
    sourcePath,
    "--runtime",
    runtimePath,
    "--destination",
    destination,
    "--version",
    "1.1.70",
  ];
  return { sourcePath, runtimePath, destination, args };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("isolated render canary configuration", () => {
  it("creates a schema-valid isolated stack using deployed networking and architecture", () => {
    const files = fixture();
    const result = run(files.args);
    expect(result.status, result.stderr).toBe(0);
    const config = infrastructureConfigSchema.parse(
      JSON.parse(readFileSync(files.destination, "utf8")),
    );
    expect(config).toMatchObject({
      stackName: "PublisherProductionRenderCanary",
      callerRoleArn: source.callerRoleArn,
      attachCallerPolicy: false,
      publisherExporterSource: "local-tarball",
      publisherExporterVersion: "1.1.70",
      targets: [],
      workspace: {
        prefix: "render-canary/",
        lifecycleDays: 1,
        retainOnDelete: true,
      },
      network: {
        vpcId: runtime.VpcConfig.VpcId,
        subnetIds: runtime.VpcConfig.SubnetIds,
        securityGroupIds: runtime.VpcConfig.SecurityGroupIds,
        proxyUrl: source.network.proxyUrl,
        manageOriginIngress: false,
        createS3GatewayEndpoint: false,
        createDynamoDbGatewayEndpoint: false,
        s3GatewayEndpointRouteTableIds: [],
      },
      workers: {
        architecture: "arm64",
        renderMemoryMiB: 4096,
        renderConcurrency: 1,
        assetConcurrency: 1,
        rewriteConcurrency: 1,
        deployConcurrency: 1,
        logRetentionDays: "1",
      },
    });
    expect(config.workspace.bucketName).toBeUndefined();
    expect(JSON.parse(readFileSync(files.sourcePath, "utf8"))).toEqual(source);
    expect(JSON.parse(readFileSync(files.runtimePath, "utf8"))).toEqual(
      runtime,
    );
    expect(statSync(files.destination).mode & 0o777).toBe(0o600);
  });

  it("exports a pure derivation without executing its CLI on import", () => {
    const code = `
      import assert from 'node:assert/strict';
      import { deriveCanaryConfig } from ${JSON.stringify(pathToFileURL(script).href)};
      const source = ${JSON.stringify(source)};
      const runtime = ${JSON.stringify(runtime)};
      const before = JSON.stringify([source, runtime]);
      const result = deriveCanaryConfig(source, runtime, '1.1.71-rc.1');
      assert.equal(JSON.stringify([source, runtime]), before);
      assert.equal(result.publisherExporterVersion, '1.1.71-rc.1');
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", code],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each([
    [
      "mismatched VPC",
      {
        ...runtime,
        VpcConfig: { ...runtime.VpcConfig, VpcId: "vpc-99999999" },
      },
    ],
    [
      "empty subnet list",
      { ...runtime, VpcConfig: { ...runtime.VpcConfig, SubnetIds: [] } },
    ],
    [
      "empty security groups",
      { ...runtime, VpcConfig: { ...runtime.VpcConfig, SecurityGroupIds: [] } },
    ],
    [
      "invalid subnet",
      {
        ...runtime,
        VpcConfig: { ...runtime.VpcConfig, SubnetIds: ["subnet-wrong"] },
      },
    ],
    [
      "duplicate subnet",
      {
        ...runtime,
        VpcConfig: {
          ...runtime.VpcConfig,
          SubnetIds: ["subnet-aaaaaaaa", "subnet-aaaaaaaa"],
        },
      },
    ],
    ["missing architecture", { VpcConfig: runtime.VpcConfig }],
    [
      "multiple architectures",
      { ...runtime, Architectures: ["arm64", "x86_64"] },
    ],
    ["unsupported architecture", { ...runtime, Architectures: ["riscv"] }],
  ])("rejects %s", (_name, deployed) => {
    const files = fixture(source, deployed);
    expect(run(files.args).status).not.toBe(0);
  });

  it("rejects an overlong derived stack name and non-semantic version", () => {
    const long = fixture({ ...source, stackName: "A".repeat(128) });
    expect(run(long.args).stderr).toContain("128");
    const files = fixture();
    files.args[files.args.length - 1] = "latest";
    expect(run(files.args).stderr).toContain("semantic version");
  });

  it("resolves default VPC selection to the deployed explicit VPC", () => {
    const { vpcId: _vpcId, ...network } = source.network;
    expect(_vpcId).toBe(runtime.VpcConfig.VpcId);
    const files = fixture(
      { ...source, network: { ...network, useDefaultVpc: true } },
      { ...runtime, Architectures: ["x86_64"] },
    );
    expect(run(files.args).status).toBe(0);
    const config = infrastructureConfigSchema.parse(
      JSON.parse(readFileSync(files.destination, "utf8")),
    );
    expect(config.network.vpcId).toBe(runtime.VpcConfig.VpcId);
    expect(config.network.useDefaultVpc).toBe(false);
    expect(config.workers.architecture).toBe("x86_64");
  });

  it("refuses to overwrite inputs, existing outputs, or symlink aliases", () => {
    const files = fixture();
    const original = readFileSync(files.sourcePath, "utf8");
    const inputArgs = [...files.args];
    inputArgs[5] = files.sourcePath;
    expect(run(inputArgs).stderr).toContain("must not overwrite");
    expect(run(files.args).status).toBe(0);
    expect(run(files.args).status).not.toBe(0);
    const alias = path.join(path.dirname(files.sourcePath), "alias.json");
    symlinkSync(files.sourcePath, alias);
    inputArgs[5] = alias;
    expect(run(inputArgs).status).not.toBe(0);
    expect(readFileSync(files.sourcePath, "utf8")).toBe(original);
  });

  it("rejects missing, duplicate, and unknown CLI options", () => {
    const files = fixture();
    expect(run(files.args.slice(0, -2)).status).not.toBe(0);
    expect(run([...files.args, "--version", "1.1.70"]).status).not.toBe(0);
    expect(run([...files.args, "--deploy", "true"]).status).not.toBe(0);
  });
});
