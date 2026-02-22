import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/loader.js";
import { readJsonTraces } from "../ingestion/json.js";
import { readLangSmithTraces } from "../ingestion/langsmith.js";
import { readOtelTraces } from "../ingestion/otel.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { PoliciesFileSchema, type Policy } from "../policy/types.js";
import { DEFAULT_MAX_CONVERSATIONS } from "../config/defaults.js";

interface AnalyzeOptions {
  traces?: string;
  langsmith?: string;
  otel?: string;
  policies?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  dryRun?: boolean;
  maxConversations?: string;
  includePrompt?: boolean;
  summaryOnly?: boolean;
  output?: string;
}

export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
  // Load policies
  const policiesPath = resolve(
    process.cwd(),
    options.policies ?? "policies.json",
  );
  if (!existsSync(policiesPath)) {
    console.error(
      "Error: No policies.json found.\n" +
        "Run `converra-triage init --prompt <path>` first to extract policies.",
    );
    process.exit(1);
  }

  const policiesRaw = await readFile(policiesPath, "utf-8");
  const policies: Policy[] = PoliciesFileSchema.parse(JSON.parse(policiesRaw));
  console.log(`Loaded ${policies.length} policies from ${policiesPath}`);

  // Ingest traces
  const conversations = await ingestTraces(options);
  const maxConvs = options.maxConversations
    ? parseInt(options.maxConversations, 10)
    : DEFAULT_MAX_CONVERSATIONS;

  if (conversations.length > maxConvs) {
    console.warn(
      `\nWarning: ${conversations.length} conversations found, but max is ${maxConvs}. ` +
        `Use --max-conversations to increase the limit. Truncating to ${maxConvs}.\n`,
    );
  }

  const limited = conversations.slice(0, maxConvs);

  console.log(
    `\nLoaded ${limited.length} conversations` +
      (conversations.length > maxConvs
        ? ` (of ${conversations.length} total)`
        : "") +
      ".",
  );

  // Phase 2 stops here — evaluation is Phase 3
  if (options.dryRun) {
    const estimatedCalls = limited.length * 2 + policies.length;
    console.log(`\n--- Dry Run ---`);
    console.log(`Conversations: ${limited.length}`);
    console.log(`Policies: ${policies.length}`);
    console.log(
      `Estimated LLM calls: ~${estimatedCalls} (${limited.length} evaluations + ${limited.length} policy checks + ${policies.length} fix generations)`,
    );
    console.log(
      `Estimated cost with gpt-4o-mini: ~$${(limited.length * 0.012).toFixed(2)}`,
    );
    return;
  }

  console.log(
    "\nPhase 2 complete: traces ingested and normalized. " +
      "Evaluation engine (Phase 3) will process these.",
  );
}

async function ingestTraces(
  options: AnalyzeOptions,
): Promise<NormalizedConversation[]> {
  if (options.traces) {
    console.log(`Reading traces from ${options.traces}...`);
    return readJsonTraces(options.traces);
  }

  if (options.langsmith) {
    const config = await loadConfig();
    const apiKey =
      options.apiKey ??
      process.env.LANGSMITH_API_KEY ??
      config.traces?.apiKey;
    if (!apiKey) {
      console.error(
        "Error: No LangSmith API key found.\n" +
          "Set LANGSMITH_API_KEY environment variable or pass --api-key.",
      );
      process.exit(1);
    }
    console.log(`Reading traces from LangSmith project: ${options.langsmith}...`);
    return readLangSmithTraces({
      apiKey,
      project: options.langsmith,
      baseUrl: config.traces?.baseUrl,
    });
  }

  if (options.otel) {
    console.log(`Reading OTLP/JSON traces from ${options.otel}...`);
    return readOtelTraces(options.otel);
  }

  console.error(
    "Error: No trace source specified.\n" +
      "Use one of:\n" +
      "  --traces ./conversations.json     (JSON file)\n" +
      "  --langsmith <project-name>        (LangSmith)\n" +
      "  --otel ./otel-export.json         (OpenTelemetry OTLP/JSON)",
  );
  process.exit(1);
}
