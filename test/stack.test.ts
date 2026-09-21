import { App, Aspects, Stack } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { infrastructureConfigSchema } from "../config/schema.js";
import { StaticPublisherWorkersStack } from "../lib/static-publisher-workers-stack.js";

function synthesize(architecture: "arm64" | "x86_64" = "arm64"): Template {
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
    publisherExporterVersion: "1.1.67",
    network: {
      useDefaultVpc: true,
      renderEgress: "proxy",
      subnetIds: [],
      securityGroupIds: [],
      proxyUrl: "http://10.0.1.10:3128",
      proxyPort: 3128,
      createS3GatewayEndpoint: true,
      createDynamoDbGatewayEndpoint: true,
      s3GatewayEndpointRouteTableIds: ["rtb-0123456789abcdef0"],
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
    workers: { architecture },
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
  it("creates four independently sized container workers", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::Lambda::Function", 4);
    template.resourceCountIs("AWS::Lambda::Alias", 4);
    template.resourceCountIs("AWS::Logs::LogGroup", 4);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 12);
    const functions = template.findResources("AWS::Lambda::Function");
    const imageUris = new Set(
      Object.values(functions)
        .filter(
          (resource) =>
            (resource as { Properties: { PackageType?: string } }).Properties
              .PackageType === "Image",
        )
        .map((resource) =>
          JSON.stringify(
            (resource as { Properties: { Code: { ImageUri: unknown } } })
              .Properties.Code.ImageUri,
          ),
        ),
    );
    expect(imageUris.size).toBe(1);
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
          PUBLISHER_PROGRESS_TABLE: Match.anyValue(),
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
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      MemorySize: 1769,
      Timeout: 600,
      EphemeralStorage: { Size: 1024 },
      ReservedConcurrentExecutions: 16,
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          PUBLISHER_ALLOWED_OPERATION: "asset",
          PUBLISHER_WORKSPACE_PREFIX: "publisher/dev/",
          PUBLISHER_PROXY_URL: "http://10.0.1.10:3128",
        }),
      },
      VpcConfig: Match.objectLike({
        SecurityGroupIds: Match.anyValue(),
        SubnetIds: Match.anyValue(),
      }),
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      Description:
        "Fetches discovered site assets and writes only to the configured workspace prefix",
    });
  }, 15_000);

  it("scopes target object access to configured prefixes", () => {
    const template = synthesize();
    const policies = template.findResources("AWS::IAM::Policy");
    expect(JSON.stringify(policies)).toContain("target-bucket/prod/www/*");
    expect(JSON.stringify(policies)).not.toContain('"Action":"s3:*"');

    const assetPolicies = Object.entries(policies).filter(([logicalId]) =>
      logicalId.startsWith("AssetWorkerRoleDefaultPolicy"),
    );
    expect(assetPolicies).toHaveLength(1);
    expect(JSON.stringify(assetPolicies)).toContain("publisher/dev/");
    expect(JSON.stringify(assetPolicies)).not.toContain("target-bucket");
    expect(JSON.stringify(assetPolicies)).toContain("s3:ListBucket");
    expect(JSON.stringify(assetPolicies)).toContain("publisher/dev/*");
    expect(JSON.stringify(assetPolicies)).not.toContain("s3:GetObjectVersion");
  });

  it("keeps the asset worker on arm64 when other workers use x86_64", () => {
    const template = synthesize("x86_64");
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({
          PUBLISHER_ALLOWED_OPERATION: "asset",
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["x86_64"],
      Environment: {
        Variables: Match.objectLike({
          PUBLISHER_ALLOWED_OPERATION: "render",
        }),
      },
    });
  });

  it("outputs the generated exporter role and worker aliases", () => {
    const template = synthesize();
    template.hasOutput("ExporterAccessRoleArn", {});
    template.hasOutput("ExporterCallerPolicyArn", {});
    template.hasOutput("RenderFunctionArn", {});
    template.hasOutput("AssetFunctionArn", {});
    template.hasOutput("RewriteFunctionArn", {});
    template.hasOutput("DeployFunctionArn", {});
    template.hasOutput("DeploymentTargets", {});
    template.hasOutput("WorkerProgressTableName", {});
    template.hasOutput("WorkerProgressTableArn", {});
  });

  it("connects worker progress with least-privilege IAM and ordered storage", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 2);
    template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
      ServiceName: "com.amazonaws.eu-central-1.dynamodb",
      VpcEndpointType: "Gateway",
      RouteTableIds: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "jobId", KeyType: "HASH" },
        { AttributeName: "taskId", KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: {
        AttributeName: "expiresAt",
        Enabled: true,
      },
    });
    template.resourceCountIs("AWS::Events::EventBus", 0);
    const policies = template.findResources("AWS::IAM::Policy");
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain("dynamodb:UpdateItem");
    expect(serialized).toContain("dynamodb:GetItem");
    expect(serialized).not.toContain("dynamodb:Scan");
    expect(serialized).not.toContain("dynamodb:DeleteItem");
    for (const rolePrefix of [
      "RenderWorkerRoleDefaultPolicy",
      "AssetWorkerRoleDefaultPolicy",
      "RewriteWorkerRoleDefaultPolicy",
      "DeployWorkerRoleDefaultPolicy",
    ]) {
      const rolePolicies = Object.entries(policies).filter(([logicalId]) =>
        logicalId.startsWith(rolePrefix),
      );
      expect(JSON.stringify(rolePolicies)).toContain("dynamodb:UpdateItem");
    }
  });
});
