import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";
import type { InfrastructureConfig } from "../config/schema.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerImageDirectory = path.resolve(sourceDirectory, "../worker/npm");
const localWorkerImageDirectory = path.resolve(
  sourceDirectory,
  "../worker/local",
);

const retentionDays: Record<string, logs.RetentionDays> = {
  "1": logs.RetentionDays.ONE_DAY,
  "3": logs.RetentionDays.THREE_DAYS,
  "5": logs.RetentionDays.FIVE_DAYS,
  "7": logs.RetentionDays.ONE_WEEK,
  "14": logs.RetentionDays.TWO_WEEKS,
  "30": logs.RetentionDays.ONE_MONTH,
  "60": logs.RetentionDays.TWO_MONTHS,
  "90": logs.RetentionDays.THREE_MONTHS,
  "120": logs.RetentionDays.FOUR_MONTHS,
  "150": logs.RetentionDays.FIVE_MONTHS,
  "180": logs.RetentionDays.SIX_MONTHS,
  "365": logs.RetentionDays.ONE_YEAR,
};

export interface StaticPublisherWorkersStackProps extends StackProps {
  readonly config: InfrastructureConfig;
  /** Test seam. Production callers should let the stack import the configured VPC. */
  readonly vpcOverride?: ec2.IVpc;
}

function normalizedObjectArn(
  stack: Stack,
  bucketName: string,
  prefix: string,
): string {
  const suffix = prefix ? `${prefix}*` : "*";
  return stack.formatArn({
    service: "s3",
    region: "",
    account: "",
    resource: bucketName,
    resourceName: suffix,
  });
}

function addBucketPrefixAccess(
  stack: Stack,
  role: iam.IRole,
  bucketName: string,
  prefix: string,
  objectActions: readonly string[],
): void {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: [...objectActions],
      resources: [normalizedObjectArn(stack, bucketName, prefix)],
    }),
  );
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [
        stack.formatArn({
          service: "s3",
          region: "",
          account: "",
          resource: bucketName,
        }),
      ],
      ...(prefix
        ? {
            conditions: {
              StringLike: {
                "s3:prefix": [prefix.slice(0, -1), `${prefix}*`],
              },
            },
          }
        : {}),
    }),
  );
}

function lambdaRole(
  scope: Construct,
  id: string,
  description: string,
  vpcAccess: boolean,
): iam.Role {
  const role = new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    description,
  });
  if (vpcAccess) {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:AssignPrivateIpAddresses",
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:UnassignPrivateIpAddresses",
        ],
        // EC2 network-interface APIs do not support resource-level permissions.
        resources: ["*"],
      }),
    );
  }
  return role;
}

function addWorkerAlarms(
  scope: Construct,
  id: string,
  worker: lambda.IFunction,
  timeoutSeconds: number,
): void {
  const commonAlarmProperties = {
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  } as const;

  new cloudwatch.Alarm(scope, `${id}ErrorsAlarm`, {
    ...commonAlarmProperties,
    metric: worker.metricErrors({ period: Duration.minutes(1) }),
    threshold: 0,
    alarmDescription: `${id} worker reported errors in at least two of three minutes`,
  });
  new cloudwatch.Alarm(scope, `${id}ThrottlesAlarm`, {
    ...commonAlarmProperties,
    metric: worker.metricThrottles({ period: Duration.minutes(1) }),
    threshold: 0,
    alarmDescription: `${id} worker was throttled in at least two of three minutes`,
  });
  new cloudwatch.Alarm(scope, `${id}DurationP99Alarm`, {
    ...commonAlarmProperties,
    metric: worker.metricDuration({
      period: Duration.minutes(1),
      statistic: "p99",
    }),
    threshold: timeoutSeconds * 800,
    alarmDescription: `${id} worker p99 duration exceeded 80 percent of its timeout`,
  });
}

export class StaticPublisherWorkersStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: StaticPublisherWorkersStackProps,
  ) {
    super(scope, id, props);

    const { config } = props;
    const vpc =
      props.vpcOverride ??
      ec2.Vpc.fromLookup(this, "Vpc", {
        ...(config.network.vpcId
          ? { vpcId: config.network.vpcId }
          : { isDefault: true }),
      });

    const subnetSelection: ec2.SubnetSelection =
      config.network.subnetIds.length > 0
        ? {
            subnetFilters: [ec2.SubnetFilter.byIds(config.network.subnetIds)],
          }
        : config.network.useDefaultVpc
          ? { subnetType: ec2.SubnetType.PUBLIC }
          : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    const workerSecurityGroups =
      config.network.securityGroupIds.length > 0
        ? config.network.securityGroupIds.map((securityGroupId, index) =>
            ec2.SecurityGroup.fromSecurityGroupId(
              this,
              `WorkerSecurityGroup${index + 1}`,
              securityGroupId,
              { mutable: false },
            ),
          )
        : [
            new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
              vpc,
              allowAllOutbound: true,
              description:
                "Outbound-only security group for Static Publisher Lambda workers",
            }),
          ];

    if (
      config.network.manageOriginIngress &&
      config.network.originSecurityGroupId
    ) {
      const originSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "OriginSecurityGroup",
        config.network.originSecurityGroupId,
        { mutable: true },
      );
      for (const workerSecurityGroup of workerSecurityGroups) {
        originSecurityGroup.addIngressRule(
          workerSecurityGroup,
          ec2.Port.tcp(config.network.proxyPort),
          "Allow Static Publisher workers to reach the private forward proxy",
        );
      }
    }

    if (config.network.createS3GatewayEndpoint) {
      if (config.network.s3GatewayEndpointRouteTableIds.length > 0) {
        new ec2.CfnVPCEndpoint(this, "S3GatewayEndpoint", {
          serviceName: `com.amazonaws.${this.region}.s3`,
          vpcEndpointType: "Gateway",
          vpcId: vpc.vpcId,
          routeTableIds: config.network.s3GatewayEndpointRouteTableIds,
        });
      } else {
        vpc.addGatewayEndpoint("S3GatewayEndpoint", {
          service: ec2.GatewayVpcEndpointAwsService.S3,
          subnets: [subnetSelection],
        });
      }
    }

    const workspaceBucket = config.workspace.bucketName
      ? s3.Bucket.fromBucketName(
          this,
          "WorkspaceBucketResource",
          config.workspace.bucketName,
        )
      : new s3.Bucket(this, "WorkspaceBucketResource", {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          versioned: false,
          lifecycleRules: [
            {
              id: "ExpirePublisherWorkspace",
              prefix: config.workspace.prefix,
              expiration: Duration.days(config.workspace.lifecycleDays),
            },
          ],
          removalPolicy: config.workspace.retainOnDelete
            ? RemovalPolicy.RETAIN
            : RemovalPolicy.DESTROY,
          autoDeleteObjects: !config.workspace.retainOnDelete,
        });
    if (!config.workspace.bucketName) {
      NagSuppressions.addResourceSuppressions(workspaceBucket, [
        {
          id: "AwsSolutions-S1",
          reason:
            "The bucket stores short-lived task payloads with lifecycle expiry; per-task result records and Lambda logs provide the operational audit trail without a second log bucket.",
        },
      ]);
    }

    const renderRole = lambdaRole(
      this,
      "RenderWorkerRole",
      "Runs Playwright render tasks and writes only to the configured workspace prefix",
      true,
    );
    const rewriteRole = lambdaRole(
      this,
      "RewriteWorkerRole",
      "Rewrites staged Static Publisher objects inside the configured workspace prefix",
      false,
    );
    const deployRole = lambdaRole(
      this,
      "DeployWorkerRole",
      "Copies finalized Static Publisher objects to explicitly configured target prefixes",
      false,
    );

    const workspaceBucketName = workspaceBucket.bucketName;
    for (const role of [renderRole, rewriteRole, deployRole]) {
      addBucketPrefixAccess(
        this,
        role,
        workspaceBucketName,
        config.workspace.prefix,
        ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
      );
    }
    for (const target of config.targets) {
      addBucketPrefixAccess(
        this,
        deployRole,
        target.bucketName,
        target.prefix,
        ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      );
    }

    const commonEnvironment = {
      PUBLISHER_EXPORTER_VERSION: config.publisherExporterVersion,
      PUBLISHER_WORKER_PROTOCOL_VERSION: "1",
      PUBLISHER_WORKSPACE_BUCKET: workspaceBucketName,
      PUBLISHER_WORKSPACE_PREFIX: config.workspace.prefix,
      PUBLISHER_ALLOWED_TARGETS: JSON.stringify(config.targets),
      ...(config.network.proxyUrl
        ? { PUBLISHER_PROXY_URL: config.network.proxyUrl }
        : {}),
    };
    const workerArchitecture =
      config.workers.architecture === "arm64"
        ? lambda.Architecture.ARM_64
        : lambda.Architecture.X86_64;
    const workerPlatform =
      config.workers.architecture === "arm64"
        ? ecrAssets.Platform.LINUX_ARM64
        : ecrAssets.Platform.LINUX_AMD64;
    const code = (): lambda.DockerImageCode =>
      lambda.DockerImageCode.fromImageAsset(
        config.publisherExporterSource === "local-tarball"
          ? localWorkerImageDirectory
          : workerImageDirectory,
        {
          buildArgs: {
            PUBLISHER_EXPORTER_VERSION: config.publisherExporterVersion,
          },
          platform: workerPlatform,
        },
      );
    const logRetention = retentionDays[config.workers.logRetentionDays];
    if (!logRetention) {
      throw new Error(
        `Unsupported log retention: ${config.workers.logRetentionDays}`,
      );
    }
    const renderLogGroup = new logs.LogGroup(this, "RenderWorkerLogGroup", {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const rewriteLogGroup = new logs.LogGroup(this, "RewriteWorkerLogGroup", {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const deployLogGroup = new logs.LogGroup(this, "DeployWorkerLogGroup", {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    renderLogGroup.grantWrite(renderRole);
    rewriteLogGroup.grantWrite(rewriteRole);
    deployLogGroup.grantWrite(deployRole);

    const renderFunction = new lambda.DockerImageFunction(
      this,
      "RenderWorkerFunction",
      {
        code: code(),
        architecture: workerArchitecture,
        role: renderRole,
        memorySize: config.workers.renderMemoryMiB,
        timeout: Duration.seconds(config.workers.renderTimeoutSeconds),
        tracing: lambda.Tracing.ACTIVE,
        ephemeralStorageSize: Size.mebibytes(
          config.workers.renderEphemeralStorageMiB,
        ),
        reservedConcurrentExecutions: config.workers.renderConcurrency,
        vpc,
        vpcSubnets: subnetSelection,
        securityGroups: workerSecurityGroups,
        // Public Lambda subnets are allowed only as an ENI placement choice.
        // They still have no public IP; HTTP(S) leaves through the configured
        // private proxy (or through a NAT route in private subnets).
        allowPublicSubnet: true,
        environment: {
          ...commonEnvironment,
          PUBLISHER_ALLOWED_OPERATION: "render",
        },
        logGroup: renderLogGroup,
        description:
          "Renders bounded WordPress page batches into the Static Publisher S3 workspace",
      },
    );
    const rewriteFunction = new lambda.DockerImageFunction(
      this,
      "RewriteWorkerFunction",
      {
        code: code(),
        architecture: workerArchitecture,
        role: rewriteRole,
        memorySize: config.workers.rewriteMemoryMiB,
        timeout: Duration.seconds(config.workers.rewriteTimeoutSeconds),
        tracing: lambda.Tracing.ACTIVE,
        reservedConcurrentExecutions: config.workers.rewriteConcurrency,
        environment: {
          ...commonEnvironment,
          PUBLISHER_ALLOWED_OPERATION: "rewrite",
        },
        logGroup: rewriteLogGroup,
        description:
          "Rewrites finalized Static Publisher text objects in the S3 workspace",
      },
    );
    const deployFunction = new lambda.DockerImageFunction(
      this,
      "DeployWorkerFunction",
      {
        code: code(),
        architecture: workerArchitecture,
        role: deployRole,
        memorySize: config.workers.deployMemoryMiB,
        timeout: Duration.seconds(config.workers.deployTimeoutSeconds),
        tracing: lambda.Tracing.ACTIVE,
        reservedConcurrentExecutions: config.workers.deployConcurrency,
        environment: {
          ...commonEnvironment,
          PUBLISHER_ALLOWED_OPERATION: "deploy-copy",
        },
        logGroup: deployLogGroup,
        description:
          "Copies finalized Static Publisher objects between approved S3 prefixes",
      },
    );

    const renderAlias = new lambda.Alias(this, "RenderWorkerLiveAlias", {
      aliasName: "live",
      version: renderFunction.currentVersion,
    });
    const rewriteAlias = new lambda.Alias(this, "RewriteWorkerLiveAlias", {
      aliasName: "live",
      version: rewriteFunction.currentVersion,
    });
    const deployAlias = new lambda.Alias(this, "DeployWorkerLiveAlias", {
      aliasName: "live",
      version: deployFunction.currentVersion,
    });

    addWorkerAlarms(
      this,
      "Render",
      renderAlias,
      config.workers.renderTimeoutSeconds,
    );
    addWorkerAlarms(
      this,
      "Rewrite",
      rewriteAlias,
      config.workers.rewriteTimeoutSeconds,
    );
    addWorkerAlarms(
      this,
      "Deploy",
      deployAlias,
      config.workers.deployTimeoutSeconds,
    );

    const exporterAccessRole = new iam.Role(this, "ExporterAccessRole", {
      assumedBy: new iam.ArnPrincipal(config.callerRoleArn),
      description:
        "Temporary credentials for the EC2 Static Publisher coordinator",
    });
    renderAlias.grantInvoke(exporterAccessRole);
    rewriteAlias.grantInvoke(exporterAccessRole);
    deployAlias.grantInvoke(exporterAccessRole);
    addBucketPrefixAccess(
      this,
      exporterAccessRole,
      workspaceBucketName,
      config.workspace.prefix,
      ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
    );
    const callerManagedPolicy = new iam.ManagedPolicy(
      this,
      "ExporterCallerManagedPolicy",
      {
        description:
          "Allows the WordPress EC2 coordinator role to assume the generated Static Publisher exporter role",
        statements: [
          new iam.PolicyStatement({
            actions: ["sts:AssumeRole"],
            resources: [exporterAccessRole.roleArn],
          }),
        ],
      },
    );
    if (config.attachCallerPolicy) {
      iam.Role.fromRoleArn(this, "CallerRole", config.callerRoleArn, {
        mutable: true,
      }).addManagedPolicy(callerManagedPolicy);
    }

    for (const role of [
      renderRole,
      rewriteRole,
      deployRole,
      exporterAccessRole,
    ]) {
      NagSuppressions.addResourceSuppressions(
        role,
        [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "Wildcards are limited to configured S3 key prefixes, one function log stream namespace, or EC2 network-interface APIs that do not support resource-level permissions.",
          },
        ],
        true,
      );
    }

    const outputs = {
      Region: this.region,
      WorkspaceBucket: workspaceBucketName,
      WorkspacePrefix: config.workspace.prefix,
      RenderFunctionArn: renderAlias.functionArn,
      RewriteFunctionArn: rewriteAlias.functionArn,
      DeployFunctionArn: deployAlias.functionArn,
      ExporterAccessRoleArn: exporterAccessRole.roleArn,
      ExporterCallerPolicyArn: callerManagedPolicy.managedPolicyArn,
      ProxyUrl: config.network.proxyUrl ?? "",
      WorkerProtocolVersion: "1",
      PublisherExporterVersion: config.publisherExporterVersion,
      DeploymentTargets: JSON.stringify(config.targets),
    };
    for (const [outputName, value] of Object.entries(outputs)) {
      new CfnOutput(this, outputName, { value });
    }
  }
}
