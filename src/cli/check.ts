import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/loader.js";
import { createLlmClient } from "../llm/client.js";
import { readJsonTraces } from "../ingestion/json.js";
import { readLangSmithTraces } from "../ingestion/langsmith.js";
import { readOtelTraces } from "../ingestion/otel.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { PoliciesFileSchema, type Policy } from "../policy/types.js";
import { DEFAULT_MAX_CONVERSATIONS } from "../config/defaults.js";
import { checkPolicies } from "../evaluation/policy-checker.js";
import type { PolicyResult } from "../evaluation/types.js";
import { applyFilters, parseDuration, createLogger } from "./filters.js";

interface CheckOptions {
  traces?: string;
  langsmith?: string;
  otel?: string;
  policies?: string;
  policy?: string[];
  prompt?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  langsmithApiKey?: string;
  since?: string;
  until?: string;
  agent?: string;
  maxConversations?: string;
  threshold?: string;
  format?: string;
}

interface CheckResult {
  policy: { id: string; name: string };
  checked: number;
  passing: number;
  failing: number;
  compliance: number;
  failures: Array<{
    conversationId: string;
    evidence: string;
    failingTurns?: number[];
  }>;
}

export async function checkCommand(options: CheckOptions): Promise<void> {
  const jsonMode = options.format === "json";
  const log = createLogger(jsonMode);

  // Load policies
  const policiesPath = resolve(process.cwd(), options.policies ?? "policies.json");
  if (!existsSync(policiesPath)) {
    console.error(
      "Error: No policies.json found.\n" +
        "Run `agent-triage init --prompt <path>` or `agent-triage analyze --langsmith <project>` first.",
    );
    process.exit(1);
  }

  const policiesRaw = await readFile(policiesPath, "utf-8");
  let policies: Policy[] = PoliciesFileSchema.parse(JSON.parse(policiesRaw));

  // Filter to specific policies if requested
  if (options.policy && options.policy.length > 0) {
    const policyIds = new Set(options.policy.map((p) => p.toLowerCase()));
    policies = policies.filter(
      (p) =>
        policyIds.has(p.id.toLowerCase()) ||
        policyIds.has(p.name.toLowerCase()),
    );
    if (policies.length === 0) {
      console.error(
        `Error: No matching policies found for: ${options.policy.join(", ")}`,
      );
      process.exit(1);
    }
  }

  log.log(`Checking ${policies.length} policies...`);

  // Ingest traces
  const conversations = await ingestTraces(options, log);

  // Apply filters
  const filtered = applyFilters(conversations, {
    since: options.langsmith ? undefined : options.since,
    until: options.langsmith ? undefined : options.until,
    agent: options.agent,
  });

  const maxConvs = options.maxConversations
    ? (() => {
        const n = parseInt(options.maxConversations, 10);
        if (isNaN(n) || n <= 0) {
          console.error(`Error: --max-conversations must be a positive number, got "${options.maxConversations}".`);
          process.exit(1);
        }
        return n;
      })()
    : DEFAULT_MAX_CONVERSATIONS;

  const limited = filtered.slice(0, maxConvs);
  log.log(`Checking against ${limited.length} conversations.`);

  if (limited.length === 0) {
    console.error("Error: No conversations found matching filters.");
    process.exit(1);
  }

  // Resolve LLM
  const config = await loadConfig({
    prompt: { path: options.prompt ?? "." },
    ...(options.provider || options.model || options.apiKey
      ? {
          llm: {
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          },
        }
      : {}),
  });

  const apiKey = resolveApiKey(config);
  const llm = createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
    config.llm.baseUrl,
  );

  log.log(`Using ${config.llm.provider}/${config.llm.model}\n`);

  // Run policy checks only (no metrics evaluation — that's the key difference from analyze)
  const allResults = new Map<string, CheckResult>();

  for (const policy of policies) {
    allResults.set(policy.id, {
      policy: { id: policy.id, name: policy.name },
      checked: 0,
      passing: 0,
      failing: 0,
      compliance: 100,
      failures: [],
    });
  }

  for (let i = 0; i < limited.length; i++) {
    const conv = limited[i];
    const systemPrompt = conv.systemPrompt ?? "";

    if (!jsonMode) {
      process.stdout.write(
        `\r  Checking: ${i + 1}/${limited.length}    `,
      );
    }

    try {
      const policyResults = await checkPolicies(llm, conv, policies, systemPrompt);

      for (const pr of policyResults) {
        const entry = allResults.get(pr.policyId);
        if (!entry) continue;

        entry.checked++;
        if (pr.passed) {
          entry.passing++;
        } else {
          entry.failing++;
          entry.failures.push({
            conversationId: conv.id,
            evidence: pr.evidence,
            failingTurns: pr.failingTurns ?? undefined,
          });
        }
      }
    } catch (error) {
      log.warn(`  Warning: Could not check conversation ${conv.id}: ${error}`);
    }
  }

  if (!jsonMode) process.stdout.write("\n");

  // Calculate compliance rates
  for (const entry of allResults.values()) {
    entry.compliance =
      entry.checked > 0
        ? Math.round((entry.passing / entry.checked) * 100)
        : 100;
  }

  const results = Array.from(allResults.values());
  const overallCompliance =
    results.reduce((sum, r) => sum + r.compliance, 0) / results.length;
  const threshold = options.threshold
    ? (() => {
        const n = parseInt(options.threshold, 10);
        if (isNaN(n) || n < 0 || n > 100) {
          console.error(`Error: --threshold must be a number between 0 and 100, got "${options.threshold}".`);
          process.exit(1);
        }
        return n;
      })()
    : undefined;
  const passed = threshold === undefined || overallCompliance >= threshold;

  // Output
  if (jsonMode) {
    console.log(
      JSON.stringify({
        policies: results,
        summary: {
          checked: limited.length,
          overallCompliance: Math.round(overallCompliance),
          threshold: threshold ?? null,
          passed,
          failures: results.reduce((sum, r) => sum + r.failing, 0),
        },
      }),
    );
  } else {
    for (const r of results) {
      const icon = r.compliance < 50 ? "✗" : r.compliance < 90 ? "⚠" : "✓";
      console.log(
        `\n  ${icon} "${r.policy.name}" — ${r.compliance}% compliance (${r.passing}/${r.checked} passing)`,
      );

      // Show up to 3 failing examples
      for (const f of r.failures.slice(0, 3)) {
        const turns = f.failingTurns?.length
          ? ` (turns: ${f.failingTurns.join(", ")})`
          : "";
        console.log(`      ✗ ${f.conversationId}${turns}: ${f.evidence.slice(0, 120)}`);
      }
      if (r.failures.length > 3) {
        console.log(`      ... and ${r.failures.length - 3} more`);
      }
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`  Checked: ${limited.length} conversations`);
    console.log(`  Overall Compliance: ${Math.round(overallCompliance)}%`);
    if (threshold !== undefined) {
      console.log(
        `  Threshold: ${threshold}% — ${passed ? "PASSED" : "FAILED"}`,
      );
    }
    console.log("");
  }

  // Exit with code 1 if threshold check fails
  if (threshold !== undefined && !passed) {
    process.exit(1);
  }
}

async function ingestTraces(
  options: CheckOptions,
  log: ReturnType<typeof createLogger>,
): Promise<NormalizedConversation[]> {
  if (options.traces) {
    log.log(`Reading traces from ${options.traces}...`);
    return readJsonTraces(options.traces);
  }

  if (options.langsmith) {
    const config = await loadConfig({ prompt: { path: "." } });
    const apiKey =
      options.langsmithApiKey ??
      process.env.LANGSMITH_API_KEY ??
      config.traces?.apiKey;
    if (!apiKey) {
      console.error(
        "Error: No LangSmith API key found.\n" +
          "Set LANGSMITH_API_KEY environment variable or pass --langsmith-api-key.",
      );
      process.exit(1);
    }
    log.log(`Reading traces from LangSmith project: ${options.langsmith}...`);
    return readLangSmithTraces({
      apiKey,
      project: options.langsmith,
      baseUrl: config.traces?.baseUrl,
      startTime: options.since ? parseDuration(options.since) : undefined,
      endTime: options.until ? parseDuration(options.until) : undefined,
    });
  }

  if (options.otel) {
    log.log(`Reading OTLP/JSON traces from ${options.otel}...`);
    return readOtelTraces(options.otel);
  }

  console.error(
    "Error: No trace source specified.\n" +
      "Use --traces, --langsmith, or --otel.",
  );
  process.exit(1);
}
