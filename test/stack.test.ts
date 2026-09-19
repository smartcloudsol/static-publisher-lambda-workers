import { App, Aspects, Stack } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { infrastructureConfigSchema } from "../config/schema.js";
import { StaticPublisherWorkersStack } from "../lib/static-publisher-workers-stack.js";

function synthesize(): Template {
  const app = new App();
  const networkStack = new Stack(app, "Network", {
    env: { account: "123456789012", region: "eu-central-1" },
  });
  const vpc = new Vpc(networkStack, "Vpc", { natGateways: 0 });
  const config = infrastructureConfigSchema.parse({
    schemaVersion: 1,
    stackName: "TestWorkers",
    account: "123456789012",
    region: "eu-central-1",
    callerRoleArn: "arn:aws:iam::123456789012:role/exporter",
    publisherExporterVersion: "1.1.62",
    network: {
      useDefaultVpc: true,
      renderEgress: "proxy",
      subnetIds: [],
      securityGroupIds: [],
      proxyUrl: "http://10.0.1.10:3128",
      proxyPort: 3128,
      createS3GatewayEndpoint: false,
    },
    workspace: { prefix: "publisher/dev/", lifecycleDays: 30 },
    targets: [
      {
        id: "production",
        bucketName: "target-bucket",
        prefix: "prod/www/",
        region: "us-east-1",
      },
    ],
  });
  const stack = new StaticPublisherWorkersStack(app, "Workers", {
    config,
    vpcOverride: vpc,
    env: { account: "123456789012", region: "eu-central-1" },
  });
  Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
  app.synth();
  const nagErrors = Annotations.fromStack(stack).findError(
    "*",
    Match.stringLikeRegexp("AwsSolutions-"),
  );
  if (nagErrors.length > 0) {
    throw new Error(
      `cdk-nag errors:\n${nagErrors.map((error) => JSON.stringify(error.entry.data)).join("\n")}`,
    );
  }
  return Template.fromStack(stack);
}

describe("StaticPublisherWorkersStack", () => {
  it("creates three independently sized container workers", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::Lambda::Function", 3);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 9);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      MemorySize: 4096,
      Timeout: 600,
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          PUBLISHER_ALLOWED_OPERATION: "render",
          PUBLISHER_WORKSPACE_PREFIX: "publisher/dev/",
          PUBLISHER_PROXY_URL: "http://10.0.1.10:3128",
        }),
      },
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      TreatMissingData: "notBreaching",
      Threshold: 480000,
    });
  });

  it("scopes target object access to configured prefixes", () => {
    const template = synthesize();
    const policies = template.findResources("AWS::IAM::Policy");
    expect(JSON.stringify(policies)).toContain("target-bucket/prod/www/*");
    expect(JSON.stringify(policies)).not.toContain('"Action":"s3:*"');
  });

  it("outputs the generated exporter role and worker aliases", () => {
    const template = synthesize();
    template.hasOutput("ExporterAccessRoleArn", {});
    template.hasOutput("ExporterCallerPolicyArn", {});
    template.hasOutput("RenderFunctionArn", {});
    template.hasOutput("RewriteFunctionArn", {});
    template.hasOutput("DeployFunctionArn", {});
    template.hasOutput("DeploymentTargets", {});
  });
});
