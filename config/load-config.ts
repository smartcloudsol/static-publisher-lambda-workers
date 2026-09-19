import fs from "node:fs";
import path from "node:path";
import {
  infrastructureConfigSchema,
  type InfrastructureConfig,
} from "./schema.js";

export function loadInfrastructureConfig(
  configPath: string,
): InfrastructureConfig {
  const absolutePath = path.resolve(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read infrastructure config ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const result = infrastructureConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid infrastructure config ${absolutePath}:\n${result.error.issues
        .map(
          (issue) => `- ${issue.path.join(".") || "config"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
  }
  return result.data;
}
