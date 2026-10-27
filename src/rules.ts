/**
 * Rule evaluation for pi-hide-models: glob matching, catalog filtering, and
 * conversion of catalog models into the legacy provider-registration form.
 */

import type { AnyModel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Model operations a rule can act on. */
export type ModelTypeFilter = "chat" | "image" | "classifier";

/** One provider-level hide rule. */
export interface HideRule {
  /** Provider id, e.g. "openrouter". */
  provider: string;
  /** Globs of model ids to hide. Matched against the model id and the
   * qualified `provider/id` form. */
  hide: string[];
  /** Exceptions: globs that always win over `hide`. */
  show?: string[];
  /** Model types the rule applies to. Defaults to chat only, so image and
   * classifier operations are never silently dropped. */
  types?: ModelTypeFilter[];
}

/** Problems found while validating raw config, one per broken rule. */
export interface RuleProblem {
  /** Index of the offending rule in the config's `rules` array. */
  index: number;
  message: string;
}

const MODEL_TYPES: readonly ModelTypeFilter[] = ["chat", "image", "classifier"];

/**
 * Compile a glob to a regular expression.
 *
 * `*` matches any run of characters **including** `/` (model ids like
 * `openai/gpt-6-luna` and `deepseek/*` rely on it), `?` matches exactly one.
 * Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (const ch of glob) {
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAny(globs: string[], id: string, qualified: string): boolean {
  return globs.some((glob) => {
    const re = globToRegExp(glob);
    return re.test(id) || re.test(qualified);
  });
}

/** The operation type of a catalog model; chat models carry no `type`. */
export function modelType(model: { type?: string }): ModelTypeFilter {
  return (model.type as ModelTypeFilter) ?? "chat";
}

function ruleTypes(rule: HideRule): readonly ModelTypeFilter[] {
  return rule.types ?? ["chat"];
}

/**
 * Whether a rule hides a model. A model outside the rule's types is never
 * hidden; a `show` match always wins over a `hide` match.
 */
export function isHidden(model: { id: string; type?: string }, rule: HideRule): boolean {
  if (!ruleTypes(rule).includes(modelType(model))) return false;
  const qualified = `${rule.provider}/${model.id}`;
  if (rule.show && matchesAny(rule.show, model.id, qualified)) return false;
  return matchesAny(rule.hide, model.id, qualified);
}

/** Keep only the models a rule leaves visible. */
export function filterCatalog<T extends { id: string; type?: string }>(catalog: readonly T[], rule: HideRule): T[] {
  return catalog.filter((model) => !isHidden(model, rule));
}

/** How many models of a catalog a rule hides (for the status command). */
export function countHidden(catalog: readonly { id: string; type?: string }[], rule: HideRule): number {
  return catalog.filter((model) => isHidden(model, rule)).length;
}

/**
 * Convert a catalog model into the legacy `ProviderModelConfig` definition
 * form expected by `pi.registerProvider(name, { models })`.
 *
 * Pi re-resolves `api` and `baseUrl` from the built-in twin by model id, so
 * the definitions stay minimal; every field present on the catalog model is
 * forwarded; `provider` and `headers` are owned by the registration itself
 * (the legacy form nullifies model headers). The explicit `type` keeps image
 * and classifier discriminants intact.
 */
export function toDefinition(model: AnyModel): ProviderModelConfig {
  const source = model as unknown as Record<string, unknown>;
  const definition: Record<string, unknown> = {
    type: modelType(model),
    id: source.id,
    name: source.name,
    api: source.api,
    baseUrl: source.baseUrl,
    input: source.input,
    output: source.output,
    cost: source.cost,
    reasoning: source.reasoning,
    contextWindow: source.contextWindow,
    maxTokens: source.maxTokens,
    promptCache: source.promptCache,
    thinkingLevelMap: source.thinkingLevelMap,
    samplingParams: source.samplingParams,
    samplingParamsByThinkingLevel: source.samplingParamsByThinkingLevel,
    compat: source.compat,
    inputLimits: source.inputLimits,
  };
  for (const key of Object.keys(definition)) {
    if (definition[key] === undefined) delete definition[key];
  }
  return definition as unknown as ProviderModelConfig;
}

/**
 * Validate the raw `rules` array from a config file.
 *
 * Returns the usable rules plus one problem per invalid entry; an invalid
 * rule is skipped rather than fatal so a single typo cannot silently disable
 * the rest.
 */
export function validateRules(raw: unknown): { rules: HideRule[]; problems: RuleProblem[] } {
  const rules: HideRule[] = [];
  const problems: RuleProblem[] = [];
  if (!Array.isArray(raw)) return { rules, problems };

  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      problems.push({ index, message: "rule must be an object" });
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const provider = candidate.provider;
    const hide = candidate.hide;
    const show = candidate.show;
    const types = candidate.types;

    if (typeof provider !== "string" || provider.trim() === "") {
      problems.push({ index, message: 'rule needs a non-empty "provider"' });
      return;
    }
    if (
      !Array.isArray(hide) ||
      hide.length === 0 ||
      hide.some((glob) => typeof glob !== "string" || glob === "")
    ) {
      problems.push({ index, message: `rule for "${provider}" needs a non-empty "hide" array of globs` });
      return;
    }
    if (show !== undefined && (!Array.isArray(show) || show.some((glob) => typeof glob !== "string"))) {
      problems.push({ index, message: `rule for "${provider}": "show" must be an array of globs` });
      return;
    }
    if (types !== undefined) {
      if (!Array.isArray(types) || types.length === 0 || types.some((type) => !MODEL_TYPES.includes(type as ModelTypeFilter))) {
        problems.push({
          index,
          message: `rule for "${provider}": "types" must be a non-empty subset of ${MODEL_TYPES.join(", ")}`,
        });
        return;
      }
    }

    rules.push({
      provider,
      hide: hide as string[],
      ...(show !== undefined ? { show: show as string[] } : {}),
      ...(types !== undefined ? { types: types as ModelTypeFilter[] } : {}),
    });
  });

  return { rules, problems };
}
