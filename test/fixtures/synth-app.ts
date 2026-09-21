#!/usr/bin/env node
import { App, Aspects, Stack } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { AwsSolutionsChecks } from "cdk-nag";
import { infrastructureConfigSchema } from "../../config/schema.js";
import { StaticPublisherWorkersStack } from "../../lib/static-publisher-workers-stack.js";

const app = new App();
const environment = { account: "123456789012", region: "eu-central-1" };
const network = new Stack(app, "FixtureNetwork", { env: environment });
const vpc = Vpc.fromVpcAttributes(network, "Vpc", {
  vpcId: "vpc-0123456789abcdef0",
  availabilityZones: ["eu-central-1a", "eu-central-1b"],
  publicSubnetIds: ["subnet-0123456789abcdef0", "subnet-0fedcba9876543210"],
  publicSubnetRouteTableIds: ["rtb-0123456789abcdef0", "rtb-0fedcba9876543210"],
});
const config = infrastructureConfigSchema.parse({
  schemaVersion: 1,
  stackName: "StaticPublisherWorkersFixture",
  account: environment.account,
  region: environment.region,
  callerRoleArn: `arn:aws:iam::${environment.account}:role/static-publisher-fixture`,
  publisherExporterVersion: "1.1.68",
  publisherExporterSource: "npm",
  network: {
    useDefaultVpc: true,
    renderEgress: "proxy",
    proxyUrl: "http://10.0.1.10:3128",
    proxyPort: 3128,
  },
  workspace: {
    prefix: "static-publisher/fixture/",
    lifecycleDays: 7,
    retainOnDelete: true,
  },
  targets: [],
});
const workers = new StaticPublisherWorkersStack(
  app,
  "StaticPublisherWorkersFixture",
  { config, env: environment, vpcOverride: vpc },
);
Aspects.of(workers).add(new AwsSolutionsChecks({ verbose: true }));
