import { z } from "zod";

const accountId = z
  .string()
  .regex(/^\d{12}$/, "Expected a 12-digit AWS account ID.");
const awsRegion = z
  .string()
  .regex(
    /^(?:af|ap|ca|cn|eu|il|me|mx|sa|us)(?:-[a-z0-9]+)+-\d+$/,
    "Expected a valid AWS Region name.",
  );
const resourceId = (kind: "vpc" | "subnet" | "sg" | "rtb") =>
  z
    .string()
    .regex(
      new RegExp(`^${kind}-[0-9a-f]{8}(?:[0-9a-f]{9})?$`),
      `Expected a valid ${kind} resource ID.`,
    );
const stackName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9-]{0,127}$/,
    "CloudFormation stack names must start with a letter and contain at most 128 letters, digits, or hyphens.",
  );
const roleArn = z
  .string()
  .trim()
  .regex(
    /^arn:(?:aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):iam::\d{12}:role\/(?:[A-Za-z0-9_+=,.@-]+\/)*[A-Za-z0-9_+=,.@-]{1,64}$/,
    "Expected an IAM role ARN.",
  );
const semanticVersion = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Expected a semantic version such as 1.1.67.",
  );

const bucketName = z
  .string()
  .trim()
  .min(3)
  .max(63)
  .regex(
    /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!xn--)(?!sthree-)(?!amzn_s3_demo_)[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
    "Expected a valid general-purpose S3 bucket name.",
  )
  .refine(
    (value) =>
      !value.includes(".-") &&
      !value.includes("-.") &&
      !value.endsWith("-s3alias") &&
      !value.endsWith("--ol-s3") &&
      !value.endsWith(".mrap") &&
      !value.endsWith("--x-s3") &&
      !value.endsWith("--table-s3"),
    "S3 bucket name uses a reserved suffix.",
  );

const containsUnsafePrefixCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || character === "\\";
  });

const prefix = z.string().transform((value, context) => {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    context.addIssue({
      code: "custom",
      message: "S3 prefixes must not be empty.",
    });
    return z.NEVER;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    context.addIssue({
      code: "custom",
      message: "S3 prefixes cannot contain dot path segments.",
    });
    return z.NEVER;
  }
  if (containsUnsafePrefixCharacter(normalized)) {
    context.addIssue({
      code: "custom",
      message: "S3 prefixes cannot contain control characters or backslashes.",
    });
    return z.NEVER;
  }
  const result = `${segments.join("/")}/`;
  if (Buffer.byteLength(result, "utf8") > 900) {
    context.addIssue({
      code: "custom",
      message: "S3 prefixes must not exceed 900 UTF-8 bytes.",
    });
    return z.NEVER;
  }
  return result;
});

const proxyUrl = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "Proxy URLs must use http or https.",
    });
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Proxy URLs must contain only a scheme, host, and optional port; do not put credentials or paths in configuration.",
    });
  }
});

const targetSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  bucketName,
  prefix,
  region: awsRegion,
});

const uniqueResourceIds = (
  values: readonly string[],
  context: z.RefinementCtx,
  path: string,
): void => {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "Resource IDs must be unique.",
    });
  }
};

export const infrastructureConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    stackName: stackName.default("WpSuiteStaticPublisherWorkers"),
    account: accountId.optional(),
    region: awsRegion,
    callerRoleArn: roleArn,
    attachCallerPolicy: z.boolean().default(false),
    publisherExporterVersion: semanticVersion,
    publisherExporterSource: z.enum(["npm", "local-tarball"]).default("npm"),
    network: z
      .object({
        vpcId: resourceId("vpc").optional(),
        useDefaultVpc: z.boolean().default(false),
        subnetIds: z.array(resourceId("subnet")).default([]),
        securityGroupIds: z.array(resourceId("sg")).default([]),
        originSecurityGroupId: resourceId("sg").optional(),
        manageOriginIngress: z.boolean().default(false),
        renderEgress: z.enum(["proxy", "nat"]).default("proxy"),
        proxyUrl: proxyUrl.optional(),
        proxyPort: z.number().int().min(1).max(65535).default(3128),
        createS3GatewayEndpoint: z.boolean().default(false),
        createDynamoDbGatewayEndpoint: z.boolean().default(true),
        s3GatewayEndpointRouteTableIds: z.array(resourceId("rtb")).default([]),
      })
      .refine((value) => Boolean(value.vpcId) !== value.useDefaultVpc, {
        message:
          "Set exactly one of network.vpcId or network.useDefaultVpc=true.",
      })
      .superRefine((value, context) => {
        uniqueResourceIds(value.subnetIds, context, "subnetIds");
        uniqueResourceIds(value.securityGroupIds, context, "securityGroupIds");
        uniqueResourceIds(
          value.s3GatewayEndpointRouteTableIds,
          context,
          "s3GatewayEndpointRouteTableIds",
        );
        if (
          (value.createS3GatewayEndpoint ||
            value.createDynamoDbGatewayEndpoint) &&
          value.subnetIds.length > 0 &&
          value.s3GatewayEndpointRouteTableIds.length === 0
        ) {
          context.addIssue({
            code: "custom",
            path: ["s3GatewayEndpointRouteTableIds"],
            message:
              "Explicit subnetIds require explicit route table IDs for stack-managed gateway endpoints.",
          });
        }
        if (
          !value.createS3GatewayEndpoint &&
          !value.createDynamoDbGatewayEndpoint &&
          value.s3GatewayEndpointRouteTableIds.length > 0
        ) {
          context.addIssue({
            code: "custom",
            path: ["s3GatewayEndpointRouteTableIds"],
            message:
              "Route table IDs are used only when a stack-managed gateway endpoint is enabled.",
          });
        }
        if (value.renderEgress === "proxy" && !value.proxyUrl) {
          context.addIssue({
            code: "custom",
            path: ["proxyUrl"],
            message: "Proxy render egress requires network.proxyUrl.",
          });
        }
        if (value.renderEgress === "nat" && value.proxyUrl) {
          context.addIssue({
            code: "custom",
            path: ["proxyUrl"],
            message: "Do not set proxyUrl when renderEgress is nat.",
          });
        }
        if (value.renderEgress === "nat" && value.useDefaultVpc) {
          context.addIssue({
            code: "custom",
            path: ["renderEgress"],
            message:
              "Default-VPC public subnets do not give Lambda internet access; use proxy egress or an explicit VPC with NAT.",
          });
        }
        if (value.manageOriginIngress) {
          if (value.renderEgress !== "proxy" || !value.proxyUrl) {
            context.addIssue({
              code: "custom",
              path: ["manageOriginIngress"],
              message:
                "Managed origin ingress is available only for proxy egress.",
            });
          }
          if (!value.originSecurityGroupId) {
            context.addIssue({
              code: "custom",
              path: ["originSecurityGroupId"],
              message:
                "manageOriginIngress requires network.originSecurityGroupId.",
            });
          }
        }
        if (value.proxyUrl) {
          const parsed = new URL(value.proxyUrl);
          const urlPort = parsed.port
            ? Number(parsed.port)
            : parsed.protocol === "https:"
              ? 443
              : 80;
          if (urlPort !== value.proxyPort) {
            context.addIssue({
              code: "custom",
              path: ["proxyPort"],
              message: "proxyPort must match the port in proxyUrl.",
            });
          }
        }
      }),
    workspace: z.object({
      bucketName: bucketName.optional(),
      prefix,
      lifecycleDays: z.number().int().min(1).max(3650).default(30),
      retainOnDelete: z.boolean().default(true),
    }),
    targets: z.array(targetSchema).default([]),
    workers: z
      .object({
        architecture: z.enum(["arm64", "x86_64"]).default("arm64"),
        renderMemoryMiB: z.number().int().min(1769).max(10240).default(4096),
        renderTimeoutSeconds: z.number().int().min(30).max(900).default(600),
        renderConcurrency: z.number().int().min(1).max(1000).default(4),
        renderEphemeralStorageMiB: z
          .number()
          .int()
          .min(512)
          .max(10240)
          .default(2048),
        assetMemoryMiB: z.number().int().min(512).max(10240).default(1769),
        assetTimeoutSeconds: z.number().int().min(30).max(900).default(600),
        assetConcurrency: z.number().int().min(1).max(1000).default(16),
        assetEphemeralStorageMiB: z
          .number()
          .int()
          .min(512)
          .max(10240)
          .default(1024),
        rewriteMemoryMiB: z.number().int().min(512).max(10240).default(1769),
        rewriteTimeoutSeconds: z.number().int().min(30).max(900).default(300),
        rewriteConcurrency: z.number().int().min(1).max(1000).default(16),
        deployMemoryMiB: z.number().int().min(512).max(10240).default(1024),
        deployTimeoutSeconds: z.number().int().min(30).max(900).default(300),
        deployConcurrency: z.number().int().min(1).max(1000).default(8),
        logRetentionDays: z
          .enum([
            "1",
            "3",
            "5",
            "7",
            "14",
            "30",
            "60",
            "90",
            "120",
            "150",
            "180",
            "365",
          ])
          .default("30"),
      })
      .prefault({}),
  })
  .superRefine((value, context) => {
    const targetIds = value.targets.map((target) => target.id);
    if (new Set(targetIds).size !== targetIds.length) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Target IDs must be unique.",
      });
    }
    if (value.account) {
      const arnAccount = value.callerRoleArn.split(":")[4];
      if (arnAccount !== value.account) {
        context.addIssue({
          code: "custom",
          path: ["callerRoleArn"],
          message: "callerRoleArn must belong to the configured account.",
        });
      }
    }
  });

export type InfrastructureConfig = z.infer<typeof infrastructureConfigSchema>;
