import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const templateUrl = new URL(
  "../config/cross-account/target-role.yaml",
  import.meta.url,
);

describe("cross-account target roles", () => {
  it("separates Lambda S3 access from coordinator S3 and CloudFront access", async () => {
    const template = await readFile(templateUrl, "utf8");
    const workerRole = template.slice(
      template.indexOf("  StaticPublisherTargetRole:"),
      template.indexOf("  StaticPublisherCoordinatorTargetRole:"),
    );
    const coordinatorRole = template.slice(
      template.indexOf("  StaticPublisherCoordinatorTargetRole:"),
      template.indexOf("Outputs:"),
    );

    expect(workerRole).toContain("AWS: !Ref SourceDeployWorkerRoleArn");
    expect(workerRole).not.toContain("SourceCoordinatorRoleArn");
    expect(workerRole).not.toContain("cloudfront:CreateInvalidation");
    expect(coordinatorRole).toContain("AWS: !Ref SourceCoordinatorRoleArn");
    expect(coordinatorRole).not.toContain("SourceDeployWorkerRoleArn");
    expect(coordinatorRole).toContain("cloudfront:CreateInvalidation");
    expect(template).toMatch(/ExternalId:\n\s+Type: String\n\s+NoEcho: true/);
    expect(template).toContain("  TargetRoleArn:");
    expect(template).toContain("  CoordinatorTargetRoleArn:");
  });
});
