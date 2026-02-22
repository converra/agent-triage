import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";
import { buildDefaultConfig } from "./defaults.js";

const CONFIG_FILENAMES = [
  "converra-triage.config.yaml",
  "converra-triage.config.yml",
  "converra-triage.config.json",
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

export async function loadConfig(overrides?: Record<string, unknown>): Promise<Config> {
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

  return ConfigSchema.parse(merged);
}

export function resolveApiKey(config: Config): string {
  if (config.llm.apiKey) return config.llm.apiKey;

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    "openai-compatible": "OPENAI_API_KEY",
  };

  const envVar = envMap[config.llm.provider];
  const key = envVar ? process.env[envVar] : undefined;

  if (!key) {
    throw new Error(
      `No API key found. Set ${envVar ?? "API key"} environment variable ` +
        `or add llm.apiKey to converra-triage.config.yaml`,
    );
  }

  return key;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
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
