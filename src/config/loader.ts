import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";
import { getDefaultModel } from "./defaults.js";

const CONFIG_FILENAMES = [
  "agent-triage.config.yaml",
  "agent-triage.config.yml",
  "agent-triage.config.json",
];

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvVarsDeep);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVarsDeep(v);
    }
    return result;
  }
  return obj;
}

function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = val;
  }
}

export async function loadConfig(overrides?: Record<string, unknown>): Promise<Config> {
  loadDotEnv();
  let fileConfig: Record<string, unknown> = {};

  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(process.cwd(), filename);
    if (existsSync(configPath)) {
      const raw = await readFile(configPath, "utf-8");
      fileConfig = filename.endsWith(".json")
        ? JSON.parse(raw)
        : parseYaml(raw);
      break;
    }
  }

  const resolved = resolveEnvVarsDeep(fileConfig) as Record<string, unknown>;
  const merged = deepMerge(resolved, overrides ?? {});

  // If provider is set but model is not, use provider-specific default
  const llm = merged.llm as Record<string, unknown> | undefined;
  if (llm?.provider && !llm.model) {
    llm.model = getDefaultModel(llm.provider as string);
  }

  return ConfigSchema.parse(merged);
}

export interface ResolvedLlm {
  apiKey: string;
  provider: Config["llm"]["provider"];
  model: string;
}

const ENV_KEYS: { provider: Config["llm"]["provider"]; envVar: string }[] = [
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  { provider: "openai", envVar: "OPENAI_API_KEY" },
];

export async function resolveLlm(config: Config): Promise<ResolvedLlm> {
  if (config.llm.apiKey) {
    return { apiKey: config.llm.apiKey, provider: config.llm.provider, model: config.llm.model };
  }

  // Try configured provider first
  const primaryEnv = ENV_KEYS.find((e) => e.provider === config.llm.provider);
  if (primaryEnv && process.env[primaryEnv.envVar]) {
    return { apiKey: process.env[primaryEnv.envVar]!, provider: config.llm.provider, model: config.llm.model };
  }

  // Auto-detect: try any available key
  for (const { provider, envVar } of ENV_KEYS) {
    const key = process.env[envVar];
    if (key) {
      return { apiKey: key, provider, model: getDefaultModel(provider) };
    }
  }

  throw new Error(
    `No API key found. Run:\n\n` +
      `  export ANTHROPIC_API_KEY=your-key-here\n\n` +
      `Or:\n\n` +
      `  export OPENAI_API_KEY=your-key-here\n`,
  );
}

/** @deprecated Use resolveLlm() instead */
export async function resolveApiKey(config: Config): Promise<string> {
  const resolved = await resolveLlm(config);
  return resolved.apiKey;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
