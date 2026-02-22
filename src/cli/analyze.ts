import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/loader.js";
import { createLlmClient } from "../llm/client.js";
import { readJsonTraces } from "../ingestion/json.js";
import { readLangSmithTraces } from "../ingestion/langsmith.js";
import { readOtelTraces } from "../ingestion/otel.js";
import type { NormalizedConversation } from "../ingestion/types.js";
import { PoliciesFileSchema, type Policy } from "../policy/types.js";
import { DEFAULT_MAX_CONVERSATIONS, estimateCost } from "../config/defaults.js";
import { evaluateAll } from "../evaluation/runner.js";
import { generateDiagnoses } from "../evaluation/diagnosis.js";
import { generateFixes, generateRecommendations } from "../evaluation/fix-generator.js";
import {
  aggregatePolicies,
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

interface AnalyzeOptions {
  traces?: string;
  langsmith?: string;
  otel?: string;
  policies?: string;
  prompt?: string;
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
  const startTime = Date.now();

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
  const policiesHash = computePoliciesHash(policiesRaw);
  console.log(`Loaded ${policies.length} policies from ${policiesPath}`);

  // Load system prompt (needed for evaluation ground truth)
  let systemPrompt = "";
  const promptPath = options.prompt;
  if (promptPath) {
    systemPrompt = await readFile(resolve(process.cwd(), promptPath), "utf-8");
  }

  // Ingest traces
  const conversations = await ingestTraces(options);
  const maxConvs = options.maxConversations
    ? parseInt(options.maxConversations, 10)
    : DEFAULT_MAX_CONVERSATIONS;

  if (conversations.length > maxConvs) {
    console.warn(
      `\nWarning: ${conversations.length} conversations found, limit is ${maxConvs}. Truncating.\n`,
    );
  }

  const limited = conversations.slice(0, maxConvs);
  console.log(`\nLoaded ${limited.length} conversations.`);

  // Dry run — estimate cost and exit
  if (options.dryRun) {
    const evalCalls = limited.length * 2;
    const diagCalls = Math.min(10, limited.length);
    const fixCalls = policies.length + 1;
    const totalCalls = evalCalls + diagCalls + fixCalls;
    console.log(`\n--- Dry Run ---`);
    console.log(`Conversations: ${limited.length}`);
    console.log(`Policies: ${policies.length}`);
    console.log(`Estimated LLM calls: ~${totalCalls}`);
    console.log(
      `Estimated cost with gpt-4o-mini: ~$${(limited.length * 0.012 + 0.15).toFixed(2)}`,
    );
    console.log(`\nRun without --dry-run to proceed.`);
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

  const apiKey = resolveApiKey(config);
  const llm = createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
    config.llm.baseUrl,
  );

  console.log(`\nUsing ${config.llm.provider}/${config.llm.model}`);

  // Check for previous progress
  const previousResults = await loadProgress(policiesHash);
  if (previousResults && previousResults.size > 0) {
    const remaining = limited.length - previousResults.size;
    const estCost = (remaining * 0.012).toFixed(2);
    console.log(
      `\nFound partial results: ${previousResults.size}/${limited.length} evaluated.` +
        ` Remaining cost: ~$${estCost}. Resuming...\n`,
    );
  }

  // If no system prompt from flag, try to get from first conversation
  if (!systemPrompt) {
    for (const conv of limited) {
      if (conv.systemPrompt) {
        systemPrompt = conv.systemPrompt;
        break;
      }
    }
  }

  if (!systemPrompt) {
    console.warn(
      "Warning: No system prompt found. Evaluation may be less accurate.\n" +
        "Use --prompt <path> to provide the agent's system prompt.\n",
    );
  }

  // Step 1: Evaluate all conversations (metrics + policy checks)
  console.log("Evaluating conversations...");
  const results = await evaluateAll(llm, limited, policies, systemPrompt, {
    concurrency: config.llm.maxConcurrency,
    policiesHash,
    previousResults: previousResults ?? undefined,
    onProgress: (completed, total, id) => {
      const pct = Math.round((completed / total) * 100);
      process.stdout.write(
        `\r  Progress: ${completed}/${total} (${pct}%) — ${id}    `,
      );
    },
  });
  process.stdout.write("\n");

  // Step 2: Aggregate failure patterns (no LLM needed)
  const failurePatterns = aggregateFailurePatterns(results);
  const totalFailures = failurePatterns.reduce((s, p) => s + p.count, 0);
  console.log(`\nFailure patterns: ${failurePatterns.length} types, ${totalFailures} total failures.`);

  // Step 3: Generate step-level diagnoses for worst conversations
  console.log("Generating diagnoses for worst conversations...");
  await generateDiagnoses(llm, results, limited, systemPrompt, (cur, total) => {
    process.stdout.write(`\r  Diagnosing: ${cur}/${total}    `);
  });
  process.stdout.write("\n");

  // Step 4: Generate fixes for failing policies
  console.log("Generating directional fixes...");
  const fixes = await generateFixes(
    llm,
    policies,
    results,
    failurePatterns,
    (cur, total) => {
      process.stdout.write(`\r  Fixes: ${cur}/${total}    `);
    },
  );
  process.stdout.write("\n");

  // Step 5: Generate top recommendations
  console.log("Generating top recommendations...");
  let recommendations: Report["failurePatterns"]["topRecommendations"] = [];
  try {
    recommendations = await generateRecommendations(
      llm,
      failurePatterns,
      policies,
      results,
    );
  } catch (error) {
    console.warn(`  Warning: Could not generate recommendations: ${error}`);
  }

  // Step 6: Aggregate and build report
  const aggregated = aggregatePolicies(policies, results);
  const metricSummary = calculateMetricSummary(results);
  const overallCompliance = calculateOverallCompliance(results);

  // Attach fixes to aggregated policies
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
    converraTriageVersion: "0.1.0",
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

  // Write report
  const outputDir = resolve(process.cwd(), options.output ?? ".");
  const reportPath = resolve(outputDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  // Clean up progress file on success
  await cleanupProgress();

  // Print summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  converra-triage Report`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Conversations: ${results.length}`);
  console.log(`  Policies: ${policies.length}`);
  console.log(`  Overall Compliance: ${overallCompliance}%`);
  console.log(`  Total Failures: ${totalFailures}`);
  console.log(
    `  Duration: ${Math.round(runDuration)}s | Cost: ~$${cost.toFixed(4)} (${totalTokens} tokens)`,
  );
  console.log(`${"═".repeat(60)}`);

  // Top failing policies
  const failing = aggregated
    .filter((p) => p.failing > 0)
    .sort((a, b) => a.complianceRate - b.complianceRate);

  if (failing.length > 0) {
    console.log(`\n  Top Failing Policies:`);
    for (const p of failing.slice(0, 5)) {
      const icon = p.complianceRate < 50 ? "✗" : "⚠";
      console.log(
        `  ${icon} "${p.name}" — ${p.complianceRate}% (${p.failing}/${p.total} failing)`,
      );
    }
  }

  // Metric summary
  console.log(`\n  Metrics:`);
  const keyMetrics = [
    "successScore",
    "aiRelevancy",
    "sentiment",
    "hallucinationScore",
    "contextRetentionScore",
    "clarity",
  ];
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
  console.log(`  Run \`converra-triage view\` to open in browser.\n`);
}

async function ingestTraces(
  options: AnalyzeOptions,
): Promise<NormalizedConversation[]> {
  if (options.traces) {
    console.log(`Reading traces from ${options.traces}...`);
    return readJsonTraces(options.traces);
  }

  if (options.langsmith) {
    const config = await loadConfig({ prompt: { path: "." } });
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
    console.log(
      `Reading traces from LangSmith project: ${options.langsmith}...`,
    );
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
