import { describe, expect, it } from "vitest";
import { infrastructureConfigSchema } from "../config/schema.js";

const baseConfig = {
  schemaVersion: 1,
  region: "eu-central-1",
  callerRoleArn: "arn:aws:iam::123456789012:role/exporter",
  publisherExporterVersion: "1.1.65",
  network: {
    vpcId: "vpc-0123456789abcdef0",
    subnetIds: ["subnet-0123456789abcdef0"],
    securityGroupIds: ["sg-0123456789abcdef0"],
    renderEgress: "proxy",
    proxyUrl: "http://10.0.1.10:3128",
    proxyPort: 3128,
    createS3GatewayEndpoint: true,
    s3GatewayEndpointRouteTableIds: ["rtb-0123456789abcdef0"],
  },
  workspace: {
    bucketName: "workspace",
    prefix: "/publisher/dev//",
  },
  targets: [
    {
      id: "production",
      bucketName: "target",
      prefix: "/prod/www/",
      region: "us-east-1",
    },
  ],
};

describe("infrastructure configuration", () => {
  it("normalizes S3 prefixes", () => {
    const parsed = infrastructureConfigSchema.parse(baseConfig);
    expect(parsed.workspace.prefix).toBe("publisher/dev/");
    expect(parsed.targets[0]?.prefix).toBe("prod/www/");
  });

  it("provides bounded asset worker capacity defaults", () => {
    const parsed = infrastructureConfigSchema.parse(baseConfig);
    expect(parsed.workers.assetMemoryMiB).toBe(1769);
    expect(parsed.workers.assetTimeoutSeconds).toBe(600);
    expect(parsed.workers.assetConcurrency).toBe(16);
    expect(parsed.workers.assetEphemeralStorageMiB).toBe(1024);
  });

  it("rejects asset worker settings outside Lambda limits", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        workers: { assetConcurrency: 0 },
      }),
    ).toThrow();
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        workers: { assetTimeoutSeconds: 901 },
      }),
    ).toThrow();
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        workers: { assetEphemeralStorageMiB: 511 },
      }),
    ).toThrow();
  });

  it("rejects unsafe S3 prefixes", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        workspace: { bucketName: "workspace", prefix: "publisher/../other" },
      }),
    ).toThrow(/dot path segments/);
  });

  it("requires exactly one VPC selection mode", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          ...baseConfig.network,
          vpcId: "vpc-0123456789abcdef0",
          useDefaultVpc: true,
        },
      }),
    ).toThrow(/exactly one/);
  });

  it("requires route tables for an S3 endpoint with explicit subnets", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          vpcId: "vpc-0123456789abcdef0",
          subnetIds: ["subnet-0123456789abcdef0"],
          renderEgress: "proxy",
          proxyUrl: "http://10.0.1.10:3128",
          proxyPort: 3128,
          createS3GatewayEndpoint: true,
        },
      }),
    ).toThrow(/route table IDs/);
  });

  it("rejects empty workspace and target prefixes", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        workspace: { bucketName: "workspace", prefix: "/" },
      }),
    ).toThrow(/must not be empty/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        targets: [{ ...baseConfig.targets[0], prefix: "" }],
      }),
    ).toThrow(/must not be empty/);
  });

  it("rejects duplicate target IDs", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        targets: [baseConfig.targets[0], baseConfig.targets[0]],
      }),
    ).toThrow(/Target IDs must be unique/);
  });

  it("rejects malformed AWS identifiers and stack names", () => {
    expect(() =>
      infrastructureConfigSchema.parse({ ...baseConfig, region: "earth-1" }),
    ).toThrow(/AWS Region/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        callerRoleArn: "arn:aws:iam::123:role/exporter",
      }),
    ).toThrow(/IAM role ARN/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        stackName: "1-invalid-stack",
      }),
    ).toThrow(/CloudFormation stack names/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: { ...baseConfig.network, subnetIds: ["subnet-invalid"] },
      }),
    ).toThrow(/subnet resource ID/);
  });

  it("requires an explicit, internally consistent render egress path", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          ...baseConfig.network,
          renderEgress: "proxy",
          proxyUrl: undefined,
        },
      }),
    ).toThrow(/requires network.proxyUrl/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          ...baseConfig.network,
          proxyUrl: "http://10.0.1.10:8080",
        },
      }),
    ).toThrow(/proxyPort must match/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          useDefaultVpc: true,
          renderEgress: "nat",
        },
      }),
    ).toThrow(/public subnets do not give Lambda internet access/);
  });

  it("requires managed proxy ingress dependencies", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          ...baseConfig.network,
          manageOriginIngress: true,
        },
      }),
    ).toThrow(/originSecurityGroupId/);
  });

  it("requires account and caller role ARN account to agree", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        account: "210987654321",
      }),
    ).toThrow(/must belong to the configured account/);
  });

  it("rejects malformed buckets and duplicate infrastructure IDs", () => {
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        workspace: { bucketName: "Invalid_Bucket", prefix: "publisher/dev" },
      }),
    ).toThrow(/S3 bucket name/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          ...baseConfig.network,
          securityGroupIds: ["sg-0123456789abcdef0", "sg-0123456789abcdef0"],
        },
      }),
    ).toThrow(/Resource IDs must be unique/);
    expect(() =>
      infrastructureConfigSchema.parse({
        ...baseConfig,
        network: {
          ...baseConfig.network,
          s3GatewayEndpointRouteTableIds: ["route-table-123"],
        },
      }),
    ).toThrow(/rtb resource ID/);
  });
});
