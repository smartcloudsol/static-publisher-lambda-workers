#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config/github-public-files.txt");
const localDenyPath = path.join(root, ".public-sync-deny");
const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv
  .slice(2)
  .filter((value) => value !== "--dry-run");

if (unknownArgs.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArgs.join(", ")}`);
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${String(result.stderr || result.stdout).trim()}`
      : "";
    throw new Error(`git ${args.join(" ")} failed.${detail}`);
  }
  return String(result.stdout ?? "").trim();
}

function lines(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("#"));
}

function remoteParts(value) {
  const scp = value.match(/^(?:[^@\s]+@)?([^:\s]+):(.+)$/u);
  if (scp && !value.includes("://")) {
    return { host: scp[1], repositoryPath: scp[2].replace(/\.git$/u, "") };
  }
  const parsed = new URL(value);
  return {
    host: parsed.hostname,
    repositoryPath: parsed.pathname.replace(/^\/+|\.git$/gu, ""),
  };
}

function sensitivePatterns(privateRemote) {
  const parts = remoteParts(privateRemote);
  const values = new Set([privateRemote, parts.host, parts.repositoryPath]);
  if (existsSync(localDenyPath)) {
    for (const value of lines(localDenyPath)) values.add(value);
  }
  return [...values].filter((value) => value.length >= 4);
}

function assertPublicSnapshot(snapshotRoot, privateRemote) {
  const tracked = git(["ls-files", "-z"], {
    cwd: snapshotRoot,
    capture: true,
  })
    .split("\0")
    .filter(Boolean);
  const forbiddenPaths = [
    ".gitlab-ci.yml",
    "config/environments/local.json",
    "config/iam/",
    "docs/gitlab-release-pipeline.md",
    "remote-workers.json",
    "scripts/ci/",
    "test/gitlab-release.test.ts",
  ];
  const badPath = tracked.find((file) =>
    forbiddenPaths.some((forbidden) =>
      forbidden.endsWith("/") ? file.startsWith(forbidden) : file === forbidden,
    ),
  );
  if (badPath) throw new Error(`Forbidden public path: ${badPath}`);

  const exactPatterns = sensitivePatterns(privateRemote);
  const credentialPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\bglpat-[A-Za-z0-9_-]{16,}\b/u,
  ];
  for (const file of tracked) {
    const content = readFileSync(path.join(snapshotRoot, file), "utf8");
    for (const pattern of exactPatterns) {
      if (content.includes(pattern)) {
        throw new Error(
          `Sensitive private value found in public file ${file}.`,
        );
      }
    }
    for (const pattern of credentialPatterns) {
      if (pattern.test(content)) {
        throw new Error(
          `Credential-shaped value found in public file ${file}.`,
        );
      }
    }
  }
}

if (git(["status", "--porcelain"], { capture: true })) {
  throw new Error("Commit or stash every change before publishing remotes.");
}
if (git(["branch", "--show-current"], { capture: true }) !== "main") {
  throw new Error("Run dual-remote publishing only from the main branch.");
}

const privateRemote = git(["remote", "get-url", "origin"], { capture: true });
const publicRemote = git(["remote", "get-url", "github"], { capture: true });
const publicParts = remoteParts(publicRemote);
if (publicParts.host !== "github.com") {
  throw new Error("The github remote must point to github.com.");
}
if (remoteParts(privateRemote).host === publicParts.host) {
  throw new Error("The private and public remotes must use different hosts.");
}

const files = lines(manifestPath);
if (new Set(files).size !== files.length) {
  throw new Error("The public file manifest contains duplicates.");
}
for (const file of files) {
  const absolute = path.join(root, file);
  if (
    !absolute.startsWith(`${root}${path.sep}`) ||
    !statSync(absolute).isFile()
  ) {
    throw new Error(`Invalid public file: ${file}`);
  }
  git(["ls-files", "--error-unmatch", "--", file], { capture: true });
}

if (!dryRun) git(["push", "origin", "main"]);

const temporary = mkdtempSync(path.join(tmpdir(), "publisher-public-sync-"));
const snapshot = path.join(temporary, "repository");
try {
  git([
    "clone",
    "--quiet",
    "--branch",
    "main",
    "--single-branch",
    publicRemote,
    snapshot,
  ]);
  git(["rm", "-r", "--quiet", "--ignore-unmatch", "."], { cwd: snapshot });
  for (const file of files) {
    const destination = path.join(snapshot, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, file), destination);
  }
  git(["add", "--all"], { cwd: snapshot });
  assertPublicSnapshot(snapshot, privateRemote);
  const changed = git(["status", "--porcelain"], {
    cwd: snapshot,
    capture: true,
  });
  if (!changed) {
    process.stdout.write("Public repository is already up to date.\n");
  } else if (dryRun) {
    process.stdout.write(
      "Public snapshot validation passed; changes were not pushed.\n",
    );
  } else {
    git(
      [
        "-c",
        "user.name=Smart Cloud Solutions",
        "-c",
        "user.email=info@smart-cloud-solutions.com",
        "commit",
        "--quiet",
        "-m",
        "chore: sync public source",
      ],
      { cwd: snapshot },
    );
    git(["push", "origin", "HEAD:main"], { cwd: snapshot });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
