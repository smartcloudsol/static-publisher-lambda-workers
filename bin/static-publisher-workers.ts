#!/usr/bin/env node
import path from "node:path";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadInfrastructureConfig } from "../config/load-config.js";
import { StaticPublisherWorkersStack } from "../lib/static-publisher-workers-stack.js";

const app = new App();
const configPath = String(
  app.node.tryGetContext("config") ??
    process.env.PUBLISHER_INFRA_CONFIG ??
    "config/environments/local.json",
).trim();
const config = loadInfrastructureConfig(path.resolve(configPath));

new StaticPublisherWorkersStack(app, config.stackName, {
  config,
  env: {
    account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
  description:
    "Elastic Lambda workers for WP Suite Static Publisher render, asset, rewrite, and S3 deploy tasks",
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
