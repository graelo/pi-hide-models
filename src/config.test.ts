/**
 * Tests for configuration loading: defaults, global tier, project tier behind
 * trust, and diagnostics.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ID, loadGlobalConfig, loadHideConfig } from "./config";

/** Create a temp git repo so the project config tier applies. */
function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-hide-models-test-"));
  execSync("git init -q", { cwd: dir });
  return dir;
}

function writeConfig(dir: string, tier: "project" | "global", config: unknown): string {
  const path =
    tier === "project"
      ? join(dir, ".pi", "extensions", EXTENSION_ID, "config.json")
      : join(dir, "extensions", EXTENSION_ID, "config.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const cleanup: string[] = [];
test.after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const OPENROUTER_RULE = { provider: "openrouter", hide: ["*"], show: ["deepseek/*"] };

test("no config anywhere: defaults, no sources", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hide-models-agent-"));
  cleanup.push(agentDir);
  const result = loadGlobalConfig({ agentDir });
  assert.deepEqual(result.config.rules, []);
  assert.equal(result.config.debug, false);
  assert.deepEqual(result.config.problems, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.candidates.length, 1);
});

test("global config: rules loaded and validated", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hide-models-agent-"));
  cleanup.push(agentDir);
  const path = writeConfig(agentDir, "global", { rules: [OPENROUTER_RULE], debug: true });
  const result = loadGlobalConfig({ agentDir });
  assert.deepEqual(result.config.rules, [OPENROUTER_RULE]);
  assert.equal(result.config.debug, true);
  assert.deepEqual(result.sources, [path]);
});

test("global config with broken rules: valid rules still load, problems reported", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hide-models-agent-"));
  cleanup.push(agentDir);
  writeConfig(agentDir, "global", { rules: [OPENROUTER_RULE, { hide: ["*"] }] });
  const result = loadGlobalConfig({ agentDir });
  assert.equal(result.config.rules.length, 1);
  assert.equal(result.config.problems.length, 1);
  assert.equal(result.config.problems[0].index, 1);
});

test("malformed JSON: reported as a problem, defaults survive", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hide-models-agent-"));
  cleanup.push(agentDir);
  const path = writeConfig(agentDir, "global", { rules: [OPENROUTER_RULE] });
  writeFileSync(path, "{ broken");
  const result = loadGlobalConfig({ agentDir });
  assert.deepEqual(result.config.rules, []);
  assert.equal(result.config.problems.length, 1);
  assert.equal(result.config.problems[0].index, -1);
  assert.match(result.config.problems[0].message, /not valid JSON/);
});

test("project tier: included when asked, first-match wins over global", () => {
  const repo = tempGitRepo();
  cleanup.push(repo);
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hide-models-agent-"));
  cleanup.push(agentDir);
  writeConfig(agentDir, "global", { rules: [{ provider: "openrouter", hide: ["openai/*"] }] });
  const projectPath = writeConfig(repo, "project", { rules: [OPENROUTER_RULE] });

  const withoutProject = loadHideConfig({ cwd: repo, agentDir, includeProject: false });
  assert.equal(withoutProject.config.rules[0].hide[0], "openai/*");

  const withProject = loadHideConfig({ cwd: repo, agentDir, includeProject: true });
  assert.deepEqual(withProject.config.rules, [OPENROUTER_RULE]);
  assert.deepEqual(withProject.sources, [projectPath]);
});

test("project tier outside a git repo: only the global tier applies", () => {
  const plainDir = mkdtempSync(join(tmpdir(), "pi-hide-models-test-"));
  cleanup.push(plainDir);
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hide-models-agent-"));
  cleanup.push(agentDir);
  const globalPath = writeConfig(agentDir, "global", { rules: [OPENROUTER_RULE] });

  const result = loadHideConfig({ cwd: plainDir, agentDir, includeProject: true });
  assert.deepEqual(result.sources, [globalPath]);
  assert.deepEqual(result.config.rules, [OPENROUTER_RULE]);
});
