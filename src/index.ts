/**
 * pi-hide-models extension
 *
 * Hides models from a provider's catalog so that pickers (`/model`, Ctrl+P),
 * `pi --list-models`, session restore, and subagent bare/fuzzy model
 * resolution can never see them — via Pi's documented provider-catalog
 * *replacement* API, not by monkey-patching internals.
 *
 * Mechanism (see README "How it works"):
 *
 * 1. At extension-factory time, `pi.registerProvider(provider, { models })`
 *    is queued with the rule-filtered catalog shipped with pi
 *    (`getAllBuiltinModels`). Pi flushes the queue before startup model
 *    selection and `--list-models`, so the filtered catalog is in effect
 *    everywhere, with no race. Supplying `models` *replaces* the provider's
 *    catalog; authentication, streaming, and refresh behavior are inherited
 *    from the built-in provider.
 * 2. A `refreshModels` hook re-filters the provider's persisted catalog on
 *    every refresh, so cost/limit metadata stays fresh and OpenRouter key
 *    personalization (the models, limits and prices of your key) keeps
 *    flowing through.
 *
 * Config: `.pi/extensions/pi-hide-models/config.json` (project, trusted
 * only) or `<agent-dir>/extensions/pi-hide-models/config.json` (global),
 * resolved by @graelo/pi-ext-config. Read at load time — apply changes with
 * `/reload` or a new session.
 */

import { getAllBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/models";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { loadConfigWithTrust, loadGlobalConfig, EXTENSION_ID } from "./config";
import { filterCatalog, toDefinition, type HideRule } from "./rules";

/**
 * The provider catalog shipped with pi, filtered by a rule.
 *
 * Returns `undefined` when the provider is not a built-in one: registering
 * a replacement for an unknown provider would compose a provider with no
 * authentication and no catalog, which is not what a typo in the config
 * should do.
 */
function filteredBuiltinCatalog(rule: HideRule): ProviderModelConfig[] | undefined {
  let catalog;
  try {
    catalog = getAllBuiltinModels(rule.provider as never);
  } catch {
    return undefined;
  }
  if (!Array.isArray(catalog) || catalog.length === 0) return undefined;
  return filterCatalog(catalog, rule).map(toDefinition);
}

/**
 * The `refreshModels` hook: re-filter the provider's persisted catalog.
 *
 * Only *full* persisted catalogs are meaningful replacements — for
 * OpenRouter, the persisted entry is the personalized catalog for your key.
 * Overlay-style entries (pi.dev deltas for other providers) and missing
 * entries keep the current catalog (returning nothing leaves it unchanged).
 */
function refreshHook(
  rule: HideRule,
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[] | undefined> {
  return async (context) => {
    const stored = context.stored;
    if (!stored || stored.lastModified !== undefined) return undefined;
    const models = (stored.models ?? []).filter(
      (model) => (model as { provider?: string }).provider === rule.provider,
    ) as { id: string; type?: string }[];
    if (models.length === 0) return undefined;
    return filterCatalog(models, rule).map((model) => toDefinition(model as never));
  };
}

/** A rule whose provider Pi does not know as a built-in. */
interface Registration {
  rule: HideRule;
  problems: string[];
}

/** Register the catalog replacement for every rule; returns the skipped ones. */
function registerRules(pi: ExtensionAPI, rules: readonly HideRule[]): Registration[] {
  const skipped: Registration[] = [];
  for (const rule of rules) {
    const models = filteredBuiltinCatalog(rule);
    if (!models) {
      skipped.push({
        rule,
        problems: [`unknown built-in provider "${rule.provider}"`],
      });
      continue;
    }
    pi.registerProvider(rule.provider, {
      models,
      // Cast: the runtime treats "no list returned" as "keep the current
      // catalog", which the SDK type does not spell out.
      refreshModels: refreshHook(rule) as ProviderConfig["refreshModels"],
    });
  }
  return skipped;
}

export default function (pi: ExtensionAPI) {
  // Factory time: registration must happen here so it is queued and flushed
  // before startup model selection and `pi --list-models`. Only the global
  // config tier is readable at this point.
  const initial = loadGlobalConfig();
  let activeRules = initial.config.rules;
  let knownProblems = [
    ...initial.config.problems.map((problem) => problem.message),
    ...registerRules(pi, activeRules).flatMap(({ rule, problems }) =>
      problems.map((message) => `rule for "${rule.provider}": ${message}`),
    ),
  ];
  let configSources = initial.sources;
  let debug = initial.config.debug;

  pi.on("session_start", (_event, ctx) => {
    // Project trust is known only now: reload with the project tier and
    // re-register when the effective rules actually changed.
    const loaded = loadConfigWithTrust(ctx);
    const skipped = registerRules(pi, loaded.config.rules);
    const problems = [
      ...loaded.config.problems.map((problem) => problem.message),
      ...skipped.flatMap(({ rule, problems }) =>
        problems.map((message) => `rule for "${rule.provider}": ${message}`),
      ),
    ];

    const rulesChanged =
      JSON.stringify(loaded.config.rules) !== JSON.stringify(activeRules) || problems.length > 0;
    activeRules = loaded.config.rules;
    configSources = loaded.sources;
    debug = loaded.config.debug;
    const newProblems = problems.filter((message) => !knownProblems.includes(message));
    knownProblems = problems;

    // Real problems are always reported; config loading info only in debug mode.
    if (newProblems.length > 0) {
      ctx.ui.notify(`[${EXTENSION_ID}] ${newProblems.join("\n")}`, "warning");
    } else if (rulesChanged && debug) {
      ctx.ui.notify(`[${EXTENSION_ID}] rules reloaded from ${configSources.join(", ")}`, "info");
    }
  });

  pi.registerCommand("hide-models", {
    description: "Show pi-hide-models rules and their effect on the registry",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const lines: string[] = [];
      if (activeRules.length === 0) {
        lines.push(`[${EXTENSION_ID}] no active rules — nothing is hidden.`);
      }
      for (const rule of activeRules) {
        const provider = ctx.modelRegistry.getProvider(rule.provider);
        const visible = provider ? provider.getModels().length : 0;
        const registered = provider ? "" : " (provider not in registry)";
        lines.push(
          `${rule.provider}: hide [${rule.hide.join(", ")}]` +
            (rule.show?.length ? ` except [${rule.show.join(", ")}]` : "") +
            ` (${(rule.types ?? ["chat"]).join(", ")})` +
            ` — ${visible} chat model(s) visible${registered}`,
        );
      }
      if (configSources.length > 0) {
        lines.push(`config: ${configSources.join(" → ")}`);
      } else {
        lines.push("config: none found (defaults in effect)");
      }
      if (knownProblems.length > 0) {
        lines.push(`problems:\n  ${knownProblems.join("\n  ")}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
