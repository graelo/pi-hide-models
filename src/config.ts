/**
 * Configuration for the pi-hide-models extension.
 *
 * Config files are resolved by @graelo/pi-ext-config: a project-local
 * `.pi/extensions/pi-hide-models/config.json` (first match) wins over the
 * global `<agent-dir>/extensions/pi-hide-models/config.json`; defaults sit
 * underneath whatever was read.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadConfig as loadConfigFile,
  type ConfigLocationOptions,
} from "@graelo/pi-ext-config";
import { validateRules, type HideRule, type RuleProblem } from "./rules";

/** Extension id used for config resolution and prefixes. */
export const EXTENSION_ID = "pi-hide-models";

/** Raw config file shape. */
export interface HideModelsConfigFile {
  /** Provider-level hide rules; an empty or missing array disables the extension. */
  rules?: unknown;
  /** Show diagnostic notifications for config loading. Default: false. */
  debug?: boolean;
}

/** Validated, ready-to-use configuration. */
export interface HideModelsConfig {
  rules: HideRule[];
  debug: boolean;
  /** Problems found while validating rules (one per broken rule). */
  problems: RuleProblem[];
}

/** Default configuration: no rules, nothing hidden. */
export const DEFAULT_CONFIG: HideModelsConfigFile = {
  rules: [],
  debug: false,
};

export interface ConfigLoadResult {
  config: HideModelsConfig;
  /** Config files that contributed, lowest priority first. */
  sources: string[];
  /** Every candidate path in priority order, whether or not it existed. */
  candidates: string[];
}

/**
 * Load and validate config from the standard locations.
 *
 * Registration happens at extension-factory time, before a session context
 * exists, so the project tier can only be considered once trust is known —
 * that is the caller's decision (`includeProject`).
 */
export function loadHideConfig(
  options: ConfigLocationOptions & { includeProject: boolean },
): ConfigLoadResult {
  const { config, sources, candidates, diagnostics } = loadConfigFile<HideModelsConfigFile>(
    EXTENSION_ID,
    DEFAULT_CONFIG,
    { ...options, strategy: "first-match" },
  );
  const { rules, problems } = validateRules(config.rules);
  // Malformed JSON in a config file is reported by the library and skipped;
  // surface those diagnostics alongside rule-validation problems.
  const allProblems = [
    ...problems,
    ...diagnostics.map((message) => ({ index: -1, message })),
  ];
  return {
    config: { rules, debug: config.debug ?? false, problems: allProblems },
    sources,
    candidates,
  };
}

/**
 * Load global configuration only. Safe before a session context exists.
 */
export function loadGlobalConfig(
  options?: Omit<ConfigLocationOptions, "includeProject">,
): ConfigLoadResult {
  return loadHideConfig({ ...options, includeProject: false });
}

/**
 * Load configuration with project trust awareness: the project tier is only
 * considered when the project is trusted. Call from `session_start`.
 */
export function loadConfigWithTrust(ctx: ExtensionContext): ConfigLoadResult {
  return loadHideConfig({
    cwd: ctx.cwd,
    includeProject: ctx.isProjectTrusted(),
  });
}
