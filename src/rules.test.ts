/**
 * Tests for rule evaluation: glob matching, exceptions, type scoping, and
 * catalog filtering.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  countHidden,
  filterCatalog,
  globToRegExp,
  isHidden,
  modelType,
  toDefinition,
  validateRules,
  type HideRule,
} from "./rules";

const rule = (overrides: Partial<HideRule> = {}): HideRule => ({
  provider: "openrouter",
  hide: ["*"],
  ...overrides,
});

test("globToRegExp: * crosses separators, ? is one char", () => {
  assert.ok(globToRegExp("deepseek/*").test("deepseek/deepseek-v4.1-flash"));
  assert.ok(globToRegExp("openai/gpt-?").test("openai/gpt-5"));
  assert.ok(!globToRegExp("openai/gpt-?").test("openai/gpt-55"));
  assert.ok(!globToRegExp("deepseek/*").test("deepseek"));
  // Regex metacharacters in ids are literal
  assert.ok(globToRegExp("x-ai/grok-4.20").test("x-ai/grok-4.20"));
  assert.ok(!globToRegExp("x-ai/grok-4.20").test("x-ai/grok-4201"));
});

test("isHidden: bare hide-all with show exceptions", () => {
  const r = rule({ show: ["deepseek/*"] });
  assert.ok(isHidden({ id: "openai/gpt-6-luna" }, r));
  assert.ok(isHidden({ id: "mistralai/mistral-large-4" }, r));
  assert.ok(!isHidden({ id: "deepseek/deepseek-v4.1-flash" }, r));
});

test("isHidden: matches the qualified provider/id form too", () => {
  const r = rule({ hide: ["openrouter/openai/*"] });
  assert.ok(isHidden({ id: "openai/gpt-6-luna" }, r));
  assert.ok(!isHidden({ id: "mistralai/mistral-large-4" }, r));
});

test("isHidden: show wins over hide", () => {
  const r = rule({ hide: ["*"], show: ["*preview*"] });
  assert.ok(!isHidden({ id: "google/gemini-3-flash-preview" }, r));
  assert.ok(isHidden({ id: "google/gemini-3-flash" }, r));
});

test("isHidden: chat-only by default; image and classifier pass through", () => {
  const r = rule();
  assert.ok(isHidden({ id: "openai/gpt-6-luna" }, r));
  assert.ok(!isHidden({ id: "black-forest-labs/flux-3-image", type: "image" }, r));
  assert.ok(!isHidden({ id: "typesafe/jev-latest", type: "classifier" }, r));
});

test("isHidden: explicit types scope the rule", () => {
  const r = rule({ types: ["image"] });
  assert.ok(!isHidden({ id: "openai/gpt-6-luna" }, r));
  assert.ok(isHidden({ id: "black-forest-labs/flux-3-image", type: "image" }, r));
  assert.ok(!isHidden({ id: "typesafe/jev-latest", type: "classifier" }, r));
});

test("modelType defaults to chat", () => {
  assert.equal(modelType({}), "chat");
  assert.equal(modelType({ type: "image" }), "image");
  assert.equal(modelType({ type: "classifier" }), "classifier");
});

test("filterCatalog and countHidden agree", () => {
  const catalog = [
    { id: "openai/gpt-6-luna" },
    { id: "deepseek/deepseek-v4.1-flash" },
    { id: "black-forest-labs/flux-3-image", type: "image" },
  ];
  const r = rule({ show: ["deepseek/*"] });
  const kept = filterCatalog(catalog, r);
  assert.deepEqual(
    kept.map((m) => m.id),
    ["deepseek/deepseek-v4.1-flash", "black-forest-labs/flux-3-image"],
  );
  assert.equal(countHidden(catalog, r), 1);
});

test("toDefinition: forwards catalog fields, sets explicit type, drops undefined", () => {
  const definition = toDefinition({
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 943_000,
    // provider/headers are owned by the registration
    provider: "openrouter",
    headers: { X: "y" },
  } as never);
  const record = definition as unknown as Record<string, unknown>;
  assert.equal(record.type, "chat");
  assert.equal(record.id, "deepseek/deepseek-v4.1-flash");
  assert.equal(record.api, "openai-completions");
  assert.equal(record.contextWindow, 1_000_000);
  assert.ok(!("provider" in record));
  assert.ok(!("headers" in record));
  assert.ok(!("promptCache" in record));
  // image models keep their discriminant
  const image = toDefinition({ id: "flux", type: "image", output: ["image"] } as never) as unknown as Record<string, unknown>;
  assert.equal(image.type, "image");
  assert.deepEqual(image.output, ["image"]);
});

test("validateRules: accepts good rules, reports broken ones by index", () => {
  const { rules, problems } = validateRules([
    { provider: "openrouter", hide: ["*"], show: ["deepseek/*"] },
    "not an object",
    { hide: ["*"] },
    { provider: "openrouter", hide: [] },
    { provider: "mistral", hide: ["*"], types: ["chat", "image"] },
    { provider: "mistral", hide: ["*"], types: ["video"] },
    { provider: "mistral", hide: ["*"], show: "deepseek/*" },
  ]);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { provider: "openrouter", hide: ["*"], show: ["deepseek/*"] });
  assert.deepEqual(rules[1], { provider: "mistral", hide: ["*"], types: ["chat", "image"] });
  assert.deepEqual(
    problems.map((p) => p.index),
    [1, 2, 3, 5, 6],
  );
  assert.match(problems[3].message, /"types"/);
});

test("validateRules: non-array input yields no rules and no problems", () => {
  assert.deepEqual(validateRules(undefined), { rules: [], problems: [] });
  assert.deepEqual(validateRules("nope"), { rules: [], problems: [] });
});
