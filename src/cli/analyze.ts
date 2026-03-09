import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveApiKey } from "../config/loader.js";
import { createLlmClient } from "../llm/client.js";
import { readJsonTraces } from "../ingestion/json.js";
import { readLangSmithTraces } from "../ingestion/langsmith.js";
import { readOtelTraces } from "../ingestion/otel.js";
import { readAxiomTraces } from "../ingestion/axiom.js";
import { readLangfuseTraces } from "../ingestion/langfuse.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { PoliciesFileSchema, type Policy } from "../policy/types.js";
import { DEFAULT_MAX_CONVERSATIONS, estimateCost } from "../config/defaults.js";
import { evaluateAll } from "../evaluation/runner.js";
import { generateDiagnoses } from "../evaluation/diagnosis.js";
import { generateFixes, generateRecommendations } from "../evaluation/fix-generator.js";
import {
  aggregatePolicies,
  aggregateByAgent,
  aggregateFailurePatterns,
  calculateMetricSummary,
  calculateOverallCompliance,
} from "../aggregation/policy-aggregator.js";
import {
  computePoliciesHash,
  loadProgress,
  cleanupProgress,
} from "../evaluation/progress.js";
import type { Report } from "../evaluation/types.js";
import { buildHtml } from "../report/generator.js";
import { autoExtractPolicies } from "../ingestion/auto-discovery.js";
import type { LlmClient } from "../llm/client.js";
import { applyFilters, parseDuration, createLogger } from "./filters.js";
import { appendHistory } from "../history.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };

export interface AnalyzeOptions {
  traces?: string;
  langsmith?: string;
  otel?: string;
  axiom?: string;
  axiomApiKey?: string;
  axiomOrgId?: string;
  langfuse?: boolean;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseHost?: string;
  policies?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  langsmithApiKey?: string;
  dryRun?: boolean;
  maxConversations?: string;
  includePrompt?: boolean;
  summaryOnly?: boolean;
  output?: string;
  since?: string;
  until?: string;
  agent?: string;
  quick?: boolean;
  format?: string;
}

export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
  const startTime = Date.now();
  const jsonMode = options.format === "json";
  const log = createLogger(jsonMode);

  // Ingest traces (with time filters pushed to API for LangSmith)
  const conversations = await ingestTraces(options, log);

  // Apply post-ingestion filters (agent name, time for non-LangSmith sources)
  const filtered = applyFilters(conversations, {
    since: (options.langsmith || options.axiom || options.langfuse) ? undefined : options.since, // LangSmith/Axiom/Langfuse handle time server-side
    until: (options.langsmith || options.axiom || options.langfuse) ? undefined : options.until,
    agent: options.agent,
  });

  if (options.agent && filtered.length < conversations.length) {
    log.log(`Filtered to agent "${options.agent}": ${filtered.length} conversations.`);
  }

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

  if (filtered.length > maxConvs) {
    log.warn(
      `\nWarning: ${filtered.length} conversations found, limit is ${maxConvs}. Truncating.\n`,
    );
  }

  const limited = filtered.slice(0, maxConvs);
  log.log(`\nLoaded ${limited.length} conversations.`);

  // Cache normalized conversations so subsequent runs can use --traces instead of re-fetching
  if (options.langsmith || options.otel || options.axiom || options.langfuse) {
    const outDir = resolve(process.cwd(), options.output ?? ".");
    await mkdir(outDir, { recursive: true });
    const cachePath = resolve(outDir, "conversations.json");
    await writeFile(cachePath, JSON.stringify(limited, null, 2), "utf-8");
    log.log(`Saved ${limited.length} conversations to ${cachePath} (re-run with --traces ${cachePath} to skip re-fetching).`);
  }

  // Resolve policies: from file, or auto-discover
  const policiesPath = resolve(
    process.cwd(),
    options.policies ?? "policies.json",
  );
  const hasPoliciesFile = existsSync(policiesPath);

  let policies: Policy[];
  let systemPrompt = "";
  let policiesHash: string;

  if (hasPoliciesFile) {
    const policiesRaw = await readFile(policiesPath, "utf-8");
    policies = PoliciesFileSchema.parse(JSON.parse(policiesRaw));
    policiesHash = computePoliciesHash(policiesRaw);
    log.log(`Loaded ${policies.length} policies from ${policiesPath}`);
  } else {
    log.log(`No policies.json found. Starting auto-discovery...\n`);

    const llm = await createLlmForOptions(options);
    const discovery = await autoExtractPolicies(llm, limited);
    policies = discovery.policies;
    systemPrompt = discovery.systemPrompt;

    if (policies.length === 0) {
      console.error(
        "Error: Auto-discovery could not extract any policies.\n" +
          "Provide policies manually: run `agent-triage init --prompt <path>` first.",
      );
      process.exit(1);
    }

    const outputPoliciesPath = resolve(process.cwd(), "policies.json");
    await writeFile(
      outputPoliciesPath,
      JSON.stringify(policies, null, 2),
      "utf-8",
    );
    log.log(`Saved to ${outputPoliciesPath}.`);

    const policiesRaw = JSON.stringify(policies);
    policiesHash = computePoliciesHash(policiesRaw);
  }

  // Load system prompt from flag if provided
  const promptPath = options.prompt;
  if (promptPath) {
    systemPrompt = await readFile(resolve(process.cwd(), promptPath), "utf-8");
  }

  // Dry run — estimate cost and exit
  if (options.dryRun) {
    const evalCalls = limited.length * (options.quick ? 1 : 2);
    const diagCalls = options.quick ? 0 : Math.min(10, limited.length);
    const fixCalls = options.quick ? 0 : policies.length + 1;
    const totalCalls = evalCalls + diagCalls + fixCalls;

    if (jsonMode) {
      console.log(JSON.stringify({
        dryRun: true,
        conversations: limited.length,
        policies: policies.length,
        estimatedCalls: totalCalls,
        estimatedCost: limited.length * (options.quick ? 0.006 : 0.012) + (options.quick ? 0 : 0.15),
        quick: options.quick ?? false,
      }));
    } else {
      const mode = options.quick ? "quick (policy checks only)" : "full (metrics + policies + diagnosis + fixes)";
      const modelLabel = options.model ?? options.provider ?? "gpt-4o-mini";
      const cost = (limited.length * (options.quick ? 0.006 : 0.012) + (options.quick ? 0 : 0.15)).toFixed(2);
      console.log(`\n--- Dry Run ---\nConversations: ${limited.length}\nPolicies: ${policies.length}\nMode: ${mode}\nEstimated LLM calls: ~${totalCalls}\nEstimated cost with ${modelLabel}: ~$${cost}\n\nRun without --dry-run to proceed.`);
    }
    return;
  }

  // Resolve LLM config
  const config = await loadConfig({
    prompt: { path: promptPath ?? "." },
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

  const apiKey = await resolveApiKey(config);
  const llm = createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
    config.llm.baseUrl,
  );

  log.log(`\nUsing ${config.llm.provider}/${config.llm.model}`);

  // Check for previous progress
  const previousResults = await loadProgress(policiesHash);
  if (previousResults && previousResults.size > 0) {
    const remaining = limited.length - previousResults.size;
    const estCost = (remaining * 0.012).toFixed(2);
    log.log(
      `\nFound partial results: ${previousResults.size}/${limited.length} evaluated.` +
        ` Remaining cost: ~$${estCost}. Resuming...\n`,
    );
  }

  // If no system prompt from flag or auto-discovery, try to get from first conversation
  if (!systemPrompt) {
    for (const conv of limited) {
      if (conv.systemPrompt) {
        systemPrompt = conv.systemPrompt;
        break;
      }
    }
  }

  if (!systemPrompt) {
    log.warn(
      "Warning: No system prompt found. Evaluation may be less accurate.\n" +
        "Use --prompt <path> to provide the agent's system prompt.\n",
    );
  }

  // Step 1: Evaluate all conversations (metrics + policy checks)
  log.log("Evaluating conversations...");
  const results = await evaluateAll(llm, limited, policies, systemPrompt, {
    concurrency: config.llm.maxConcurrency,
    policiesHash,
    previousResults: previousResults ?? undefined,
    onProgress: jsonMode
      ? undefined
      : (completed, total, id) => {
          const pct = Math.round((completed / total) * 100);
          process.stdout.write(
            `\r  Progress: ${completed}/${total} (${pct}%) — ${id}    `,
          );
        },
  });
  if (!jsonMode) process.stdout.write("\n");

  // Step 2: Aggregate failure patterns (no LLM needed)
  const failurePatterns = aggregateFailurePatterns(results);
  const totalFailures = failurePatterns.reduce((s, p) => s + p.count, 0);
  log.log(`\nFailure patterns: ${failurePatterns.length} types, ${totalFailures} total failures.`);

  // Steps 3-5: Skip in quick mode
  let fixes = new Map<string, { fix: string; blastRadius: string[] }>();
  let recommendations: Report["failurePatterns"]["topRecommendations"] = [];

  if (!options.quick) {
    // Step 3: Generate step-level diagnoses for worst conversations
    log.log("Generating diagnoses for worst conversations...");
    await generateDiagnoses(llm, results, limited, systemPrompt, jsonMode ? undefined : (cur, total) => {
      process.stdout.write(`\r  Diagnosing: ${cur}/${total}    `);
    }, config.llm.maxConcurrency);
    if (!jsonMode) process.stdout.write("\n");

    // Step 4: Generate fixes for failing policies
    log.log("Generating directional fixes...");
    fixes = await generateFixes(
      llm,
      policies,
      results,
      failurePatterns,
      jsonMode ? undefined : (cur, total) => {
        process.stdout.write(`\r  Fixes: ${cur}/${total}    `);
      },
      config.llm.maxConcurrency,
    );
    if (!jsonMode) process.stdout.write("\n");

    // Step 5: Generate top recommendations
    log.log("Generating top recommendations...");
    try {
      recommendations = await generateRecommendations(
        llm,
        failurePatterns,
        policies,
        results,
      );
    } catch (error) {
      log.warn(`  Warning: Could not generate recommendations: ${error}`);
    }
  }

  // Step 6: Aggregate and build report
  const aggregated = aggregatePolicies(policies, results);
  const agentSummaries = aggregateByAgent(limited, results, policies);
  const metricSummary = calculateMetricSummary(results);
  const overallCompliance = calculateOverallCompliance(results);

  for (const policy of aggregated) {
    const fixResult = fixes.get(policy.id);
    if (fixResult) {
      policy.fix = fixResult.fix;
      policy.blastRadius = fixResult.blastRadius;
    }
  }

  const usage = llm.getUsage();
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const cost = estimateCost(config.llm.model, usage.inputTokens, usage.outputTokens);
  const runDuration = (Date.now() - startTime) / 1000;

  const report: Report = {
    agentTriageVersion: pkg.version,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    policiesHash,
    agent: {
      name: config.agent?.name ?? "AI Agent",
      promptPath: promptPath ?? "",
      ...(options.includePrompt && systemPrompt
        ? { promptContent: systemPrompt }
        : {}),
    },
    agents: agentSummaries,
    generatedAt: new Date().toISOString(),
    runDuration,
    totalConversations: results.length,
    policies: aggregated.map((p) => ({
      ...p,
      blastRadius: p.blastRadius,
    })),
    conversations: options.summaryOnly
      ? results.map((r) => ({ ...r, messages: [] }))
      : results,
    failurePatterns: {
      byType: failurePatterns,
      topRecommendations: recommendations,
      totalFailures,
    },
    metricSummary,
    overallCompliance,
    cost: {
      totalTokens,
      estimatedCost: cost,
    },
  };

  // JSON output mode: write to stdout and exit
  if (jsonMode) {
    console.log(JSON.stringify(report));
    await cleanupProgress();
    return;
  }

  // Write report files
  const outputDir = resolve(process.cwd(), options.output ?? ".");
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }
  const reportPath = resolve(outputDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  const htmlPath = resolve(outputDir, "report.html");
  const html = buildHtml(report);
  await writeFile(htmlPath, html, "utf-8");

  await cleanupProgress();
  await appendHistory(report, outputDir);

  // Print terminal summary
  printSummary(report, aggregated, metricSummary, reportPath, htmlPath, promptPath);
}

function printSummary(
  report: Report,
  aggregated: Array<{ id: string; name: string; complianceRate: number; failing: number; evaluated: number; total: number }>,
  metricSummary: Record<string, number>,
  reportPath: string,
  htmlPath: string,
  promptPath?: string,
): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  agent-triage Report`);
  console.log(`${"═".repeat(60)}`);
  const evaluatedPolicies = report.policies.filter((p) => p.evaluated > 0).length;
  const naPolicies = report.policies.filter((p) => p.evaluated === 0).length;
  console.log(`  Conversations: ${report.totalConversations}`);
  console.log(`  Policies: ${evaluatedPolicies} evaluated of ${report.policies.length} total${naPolicies > 0 ? ` (${naPolicies} not applicable)` : ""}`);
  console.log(`  Overall Compliance: ${report.overallCompliance}%`);
  console.log(`  Total Failures: ${report.failurePatterns.totalFailures}`);
  console.log(
    `  Duration: ${Math.round(report.runDuration)}s | Cost: ~$${report.cost.estimatedCost.toFixed(4)} (${report.cost.totalTokens} tokens)`,
  );
  console.log(`${"═".repeat(60)}`);

  const failing = aggregated
    .filter((p) => p.failing > 0)
    .sort((a, b) => a.complianceRate - b.complianceRate);

  if (failing.length > 0) {
    console.log(`\n  Top Failing Policies:`);
    for (const p of failing.slice(0, 5)) {
      const icon = p.complianceRate < 50 ? "✗" : "⚠";
      const agentLabel = "sourceAgent" in p ? `[${(p as any).sourceAgent}] ` : "";
      console.log(
        `  ${icon} "${agentLabel}${p.name}" — ${p.complianceRate}% (${p.failing}/${p.evaluated} failing)`,
      );
    }
  }

  console.log(`\n  Metrics:`);
  const keyMetrics = ["successScore", "aiRelevancy", "sentiment", "hallucinationScore", "contextRetentionScore", "clarity"];
  for (const metric of keyMetrics) {
    const val = metricSummary[metric];
    if (val !== undefined) {
      const label = metric
        .replace(/Score$/, "")
        .replace(/([A-Z])/g, " $1")
        .trim();
      console.log(`    ${label}: ${val}`);
    }
  }

  console.log(`\n  Report written to ${reportPath}`);
  console.log(`  HTML report: ${htmlPath}`);
  console.log(`  Run \`agent-triage view\` to open in browser.\n`);
}

async function createLlmForOptions(options: AnalyzeOptions): Promise<LlmClient> {
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

  const apiKey = await resolveApiKey(config);
  return createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
    config.llm.baseUrl,
  );
}

async function ingestTraces(
  options: AnalyzeOptions,
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

    log.log(
      `Reading traces from LangSmith project: ${options.langsmith}...`,
    );

    return readLangSmithTraces({
      apiKey,
      project: options.langsmith,
      baseUrl: config.traces?.baseUrl,
      startTime: options.since ? parseDuration(options.since) : undefined,
      endTime: options.until ? parseDuration(options.until) : undefined,
      limit: options.maxConversations ? parseInt(options.maxConversations, 10) || undefined : undefined,
    });
  }

  if (options.otel) {
    log.log(`Reading OTLP/JSON traces from ${options.otel}...`);
    return readOtelTraces(options.otel);
  }

  if (options.axiom) {
    const apiKey = options.axiomApiKey ?? process.env.AXIOM_API_KEY;
    if (!apiKey) {
      console.error(
        "Error: No Axiom API key found.\n" +
          "Set AXIOM_API_KEY environment variable or pass --axiom-api-key.",
      );
      process.exit(1);
    }
    log.log(`Reading traces from Axiom dataset: ${options.axiom}...`);
    return readAxiomTraces({
      apiKey,
      dataset: options.axiom,
      orgId: options.axiomOrgId,
      startTime: options.since ? parseDuration(options.since) : undefined,
      endTime: options.until ? parseDuration(options.until) : undefined,
      limit: options.maxConversations ? parseInt(options.maxConversations, 10) || undefined : undefined,
    });
  }

  if (options.langfuse) {
    const publicKey = options.langfusePublicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = options.langfuseSecretKey ?? process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      console.error(
        "Error: Langfuse credentials required.\n" +
          "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY environment variables,\n" +
          "or pass --langfuse-public-key and --langfuse-secret-key.",
      );
      process.exit(1);
    }
    log.log("Reading traces from Langfuse...");
    return readLangfuseTraces({
      publicKey,
      secretKey,
      host: options.langfuseHost ?? process.env.LANGFUSE_HOST,
      startTime: options.since ? parseDuration(options.since) : undefined,
      endTime: options.until ? parseDuration(options.until) : undefined,
      limit: options.maxConversations ? parseInt(options.maxConversations, 10) || undefined : undefined,
    });
  }

  console.error(
    "Error: No trace source specified.\n" +
      "Use one of:\n" +
      "  --traces ./conversations.json     (JSON file)\n" +
      "  --langsmith <project-name>        (LangSmith)\n" +
      "  --otel ./otel-export.json         (OpenTelemetry OTLP/JSON)\n" +
      "  --axiom <dataset-name>            (Axiom)\n" +
      "  --langfuse                        (Langfuse)",
  );
  process.exit(1);
}
