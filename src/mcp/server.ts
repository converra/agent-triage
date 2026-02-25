import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  readJsonTraces,
  readLangSmithTraces,
  readOtelTraces,
  autoExtractPolicies,
  extractPolicies,
  createLlmClient,
  evaluateAll,
  checkPolicies,
  generateDiagnoses,
  generateFixes,
  generateRecommendations,
  aggregatePolicies,
  aggregateFailurePatterns,
  calculateMetricSummary,
  calculateOverallCompliance,
  buildHtml,
  diffReports,
  loadConfig,
  resolveApiKey,
  estimateCost,
  applyFilters,
  parseDuration,
  parseJsonResponse,
} from "../index.js";

import type {
  NormalizedConversation,
  Policy,
  Report,
  LlmClient,
} from "../index.js";

import { PoliciesFileSchema } from "../policy/types.js";
import { computePoliciesHash, loadProgress, cleanupProgress } from "../evaluation/progress.js";
import { buildDiagnosisPrompt } from "../llm/prompts.js";
import type { Diagnosis, ConversationResult } from "../evaluation/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

async function resolveLlm(overrides?: {
  provider?: string;
  model?: string;
  apiKey?: string;
}): Promise<LlmClient> {
  const config = await loadConfig({
    prompt: { path: "." },
    ...(overrides?.provider || overrides?.model || overrides?.apiKey
      ? {
          llm: {
            ...(overrides.provider ? { provider: overrides.provider } : {}),
            ...(overrides.model ? { model: overrides.model } : {}),
            ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
          },
        }
      : {}),
  });

  const apiKey = resolveApiKey(config);
  return createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
    config.llm.baseUrl,
  );
}

async function ingestTraces(params: {
  traces?: string;
  langsmith?: string;
  otel?: string;
  since?: string;
  until?: string;
}): Promise<NormalizedConversation[]> {
  if (params.traces) {
    return readJsonTraces(resolve(process.cwd(), params.traces));
  }

  if (params.langsmith) {
    const config = await loadConfig({ prompt: { path: "." } });
    const apiKey =
      process.env.LANGSMITH_API_KEY ?? config.traces?.apiKey;
    if (!apiKey) {
      throw new Error(
        "No LangSmith API key found. Set LANGSMITH_API_KEY environment variable.",
      );
    }
    return readLangSmithTraces({
      apiKey,
      project: params.langsmith,
      baseUrl: config.traces?.baseUrl,
      startTime: params.since ? parseDuration(params.since) : undefined,
      endTime: params.until ? parseDuration(params.until) : undefined,
    });
  }

  if (params.otel) {
    return readOtelTraces(resolve(process.cwd(), params.otel));
  }

  throw new Error(
    "No trace source specified. Provide one of: traces (JSON file path), langsmith (project name), or otel (OTLP/JSON file path).",
  );
}

function loadPoliciesFromFile(path?: string): Policy[] {
  const policiesPath = resolve(process.cwd(), path ?? "policies.json");
  if (!existsSync(policiesPath)) {
    throw new Error(
      `No policies.json found at ${policiesPath}. Run triage_init or triage_analyze first.`,
    );
  }

  const raw = require("node:fs").readFileSync(policiesPath, "utf-8") as string;
  return PoliciesFileSchema.parse(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // 1. triage_status — Zero-cost health check from existing report
  // -------------------------------------------------------------------------
  server.registerTool("triage_status", {
    title: "Agent Triage: Status",
    description:
      "Quick health check from the last analysis report. Zero LLM cost — reads report.json from disk. " +
      "Returns overall compliance, worst policies, critical issues, and recommendations. " +
      "Use this first to understand current agent health before running expensive analysis.",
    inputSchema: {
      report_dir: z
        .string()
        .optional()
        .describe("Directory containing report.json (default: current directory)"),
    },
  }, async ({ report_dir }) => {
    const reportDir = resolve(process.cwd(), report_dir ?? ".");
    const reportPath = resolve(reportDir, "report.json");

    if (!existsSync(reportPath)) {
      return errorResult(
        "No report.json found. Run triage_analyze to generate your first report.",
      );
    }

    const report = JSON.parse(
      await readFile(reportPath, "utf-8"),
    ) as Report;

    const reportAge = Date.now() - new Date(report.generatedAt).getTime();
    const ageHours = Math.floor(reportAge / 3_600_000);
    const ageDays = Math.floor(reportAge / 86_400_000);
    const ageStr =
      ageDays > 0 ? `${ageDays}d ago` : ageHours > 0 ? `${ageHours}h ago` : "just now";

    const criticalCount = report.conversations.filter(
      (c) => c.diagnosis?.severity === "critical",
    ).length;

    const worstPolicies = report.policies
      .filter((p) => p.failing > 0)
      .sort((a, b) => a.complianceRate - b.complianceRate)
      .slice(0, 5)
      .map((p) => ({
        id: p.id,
        name: p.name,
        compliance: p.complianceRate,
        failing: p.failing,
        total: p.total,
      }));

    return jsonResult({
      generatedAt: report.generatedAt,
      age: ageStr,
      stale: ageDays >= 1,
      totalConversations: report.totalConversations,
      overallCompliance: report.overallCompliance,
      criticalIssues: criticalCount,
      worstPolicies,
      metricSummary: report.metricSummary,
      topRecommendation: report.failurePatterns.topRecommendations[0] ?? null,
      totalFailures: report.failurePatterns.totalFailures,
    });
  });

  // -------------------------------------------------------------------------
  // 2. triage_list_policies — List loaded policies
  // -------------------------------------------------------------------------
  server.registerTool("triage_list_policies", {
    title: "Agent Triage: List Policies",
    description:
      "List all behavioral policies from policies.json. Zero LLM cost. " +
      "Returns policy IDs, names, descriptions, categories, and complexity scores.",
    inputSchema: {
      policies_path: z
        .string()
        .optional()
        .describe("Path to policies.json (default: ./policies.json)"),
    },
  }, async ({ policies_path }) => {
    try {
      const policies = loadPoliciesFromFile(policies_path);
      return jsonResult({
        count: policies.length,
        policies: policies.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          category: p.category,
          complexity: p.complexity,
        })),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // 3. triage_diff — Compare two reports
  // -------------------------------------------------------------------------
  server.registerTool("triage_diff", {
    title: "Agent Triage: Diff Reports",
    description:
      "Compare two report.json files to see what changed between runs. Zero LLM cost. " +
      "Returns per-policy compliance changes, new/resolved failures, and metric deltas.",
    inputSchema: {
      before_path: z.string().describe("Path to the before report.json"),
      after_path: z.string().describe("Path to the after report.json"),
    },
  }, async ({ before_path, after_path }) => {
    try {
      const beforeRaw = await readFile(resolve(process.cwd(), before_path), "utf-8");
      const afterRaw = await readFile(resolve(process.cwd(), after_path), "utf-8");
      const before = JSON.parse(beforeRaw) as Report;
      const after = JSON.parse(afterRaw) as Report;
      const diff = diffReports(before, after);
      return jsonResult(diff);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // 4. triage_init — Extract policies from a system prompt
  // -------------------------------------------------------------------------
  server.registerTool("triage_init", {
    title: "Agent Triage: Init Policies",
    description:
      "Extract testable behavioral policies from an agent's system prompt using LLM analysis. " +
      "Moderate LLM cost (~1 API call). Writes policies.json for use by other tools.",
    inputSchema: {
      prompt_path: z.string().describe("Path to the system prompt file"),
      output_path: z
        .string()
        .optional()
        .describe("Output path for policies.json (default: ./policies.json)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ prompt_path, output_path }) => {
    try {
      const promptContent = await readFile(
        resolve(process.cwd(), prompt_path),
        "utf-8",
      );

      const llm = await resolveLlm();
      const policies = await extractPolicies(llm, promptContent);

      const outPath = resolve(process.cwd(), output_path ?? "policies.json");
      await writeFile(outPath, JSON.stringify(policies, null, 2), "utf-8");

      const usage = llm.getUsage();
      return jsonResult({
        policiesExtracted: policies.length,
        outputPath: outPath,
        policies: policies.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
        })),
        cost: {
          calls: usage.calls,
          tokens: usage.inputTokens + usage.outputTokens,
        },
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // 5. triage_explain — Deep-dive into a single conversation
  // -------------------------------------------------------------------------
  server.registerTool("triage_explain", {
    title: "Agent Triage: Explain Conversation",
    description:
      "Deep-dive diagnosis of a single conversation — root cause, cascade chain, blast radius, and suggested fix. " +
      "If a report.json exists with a diagnosis, returns it at zero cost. " +
      "Otherwise generates a diagnosis (moderate LLM cost). " +
      "Use worst=true to automatically pick the worst conversation from the last report.",
    inputSchema: {
      conversation_id: z
        .string()
        .optional()
        .describe("Conversation ID to explain (omit if using worst=true)"),
      worst: z
        .boolean()
        .optional()
        .describe("Explain the worst conversation from the last report"),
      report_dir: z
        .string()
        .optional()
        .describe("Directory containing report.json (default: current directory)"),
      traces: z.string().optional().describe("Path to JSON traces file"),
      langsmith: z.string().optional().describe("LangSmith project name"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file"),
      policies_path: z.string().optional().describe("Path to policies.json"),
      prompt_path: z.string().optional().describe("Path to system prompt file"),
    },
  }, async (params) => {
    try {
      const reportDir = resolve(process.cwd(), params.report_dir ?? ".");
      const reportPath = resolve(reportDir, "report.json");
      const hasReport = existsSync(reportPath);

      // --worst or no conversation_id: find worst from report
      if (params.worst || !params.conversation_id) {
        if (!hasReport) {
          return errorResult(
            "No report.json found. Run triage_analyze first, or provide a conversation_id.",
          );
        }

        const report = JSON.parse(await readFile(reportPath, "utf-8")) as Report;
        const scored = report.conversations
          .map((c) => ({
            result: c,
            failCount: c.policyResults.filter((pr) => !pr.passed).length,
            avgScore: averageMetrics(c.metrics),
          }))
          .filter((s) => s.failCount > 0)
          .sort((a, b) => b.failCount - a.failCount || a.avgScore - b.avgScore);

        if (scored.length === 0) {
          return jsonResult({ message: "No failing conversations found. All policies passing." });
        }

        const worst = scored[0].result;

        if (worst.diagnosis) {
          return jsonResult(formatExplanation(worst));
        }

        // Generate diagnosis on demand
        const llm = await resolveLlm();
        const diagnosis = await generateDiagnosisForResult(
          llm,
          worst,
          report.agent.promptContent ?? "",
        );
        if (diagnosis) worst.diagnosis = diagnosis;
        return jsonResult(formatExplanation(worst));
      }

      // Specific conversation ID
      if (hasReport) {
        const report = JSON.parse(await readFile(reportPath, "utf-8")) as Report;
        const existing = report.conversations.find((c) => c.id === params.conversation_id);

        if (existing?.diagnosis) {
          return jsonResult(formatExplanation(existing));
        }

        if (existing) {
          const llm = await resolveLlm();
          const diagnosis = await generateDiagnosisForResult(
            llm,
            existing,
            report.agent.promptContent ?? "",
          );
          if (diagnosis) existing.diagnosis = diagnosis;
          return jsonResult(formatExplanation(existing));
        }
      }

      // Not in report — need a trace source
      if (!params.langsmith && !params.traces && !params.otel) {
        return errorResult(
          `Conversation "${params.conversation_id}" not found in report.json. ` +
            "Provide a trace source (traces, langsmith, or otel) to fetch and evaluate it.",
        );
      }

      const conversations = await ingestTraces(params);
      const conv = conversations.find((c) => c.id === params.conversation_id);
      if (!conv) {
        return errorResult(`Conversation "${params.conversation_id}" not found in trace source.`);
      }

      const llm = await resolveLlm();
      const policiesPath = resolve(process.cwd(), params.policies_path ?? "policies.json");
      let policies: Policy[] = [];
      if (existsSync(policiesPath)) {
        const raw = await readFile(policiesPath, "utf-8");
        policies = PoliciesFileSchema.parse(JSON.parse(raw));
      }

      const systemPrompt = params.prompt_path
        ? await readFile(resolve(process.cwd(), params.prompt_path), "utf-8")
        : conv.systemPrompt ?? "";

      const { evaluateConversation } = await import("../evaluation/evaluator.js");
      const [metrics, policyResults] = await Promise.all([
        evaluateConversation(llm, conv, systemPrompt),
        policies.length > 0
          ? checkPolicies(llm, conv, policies, systemPrompt)
          : Promise.resolve([]),
      ]);

      const result: ConversationResult = {
        id: conv.id,
        metrics,
        policyResults,
        messages: conv.messages,
      };

      const hasFailures = policyResults.some((pr) => !pr.passed);
      if (hasFailures) {
        const diagnosis = await generateDiagnosisForResult(llm, result, systemPrompt);
        if (diagnosis) result.diagnosis = diagnosis;
      }

      return jsonResult(formatExplanation(result));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // 6. triage_check — Targeted policy compliance check
  // -------------------------------------------------------------------------
  server.registerTool("triage_check", {
    title: "Agent Triage: Check Policies",
    description:
      "Run policy compliance checks against traces (no metrics evaluation — faster and cheaper than full analyze). " +
      "Moderate LLM cost. Returns per-policy compliance rates with failing examples. " +
      "Use policy_ids to focus on specific policies. Use threshold for pass/fail determination.",
    inputSchema: {
      traces: z.string().optional().describe("Path to JSON traces file"),
      langsmith: z.string().optional().describe("LangSmith project name"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file"),
      policies_path: z.string().optional().describe("Path to policies.json"),
      policy_ids: z
        .array(z.string())
        .optional()
        .describe("Specific policy IDs to check (default: all)"),
      prompt_path: z.string().optional().describe("Path to system prompt file"),
      since: z.string().optional().describe("Only include traces after this time (e.g. 2h, 24h, 7d)"),
      until: z.string().optional().describe("Only include traces before this time"),
      agent: z.string().optional().describe("Filter to a specific agent by name"),
      max_conversations: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum conversations to check (default: 500)"),
      threshold: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Compliance threshold percentage for pass/fail"),
    },
    annotations: { readOnlyHint: true },
  }, async (params) => {
    try {
      let policies = loadPoliciesFromFile(params.policies_path);

      // Filter to specific policies if requested
      if (params.policy_ids && params.policy_ids.length > 0) {
        const ids = new Set(params.policy_ids.map((p) => p.toLowerCase()));
        policies = policies.filter(
          (p) => ids.has(p.id.toLowerCase()) || ids.has(p.name.toLowerCase()),
        );
        if (policies.length === 0) {
          return errorResult(
            `No matching policies found for: ${params.policy_ids.join(", ")}`,
          );
        }
      }

      const conversations = await ingestTraces(params);
      const filtered = applyFilters(conversations, {
        since: params.langsmith ? undefined : params.since,
        until: params.langsmith ? undefined : params.until,
        agent: params.agent,
      });

      const maxConvs = params.max_conversations ?? 500;
      const limited = filtered.slice(0, maxConvs);

      if (limited.length === 0) {
        return errorResult("No conversations found matching filters.");
      }

      const llm = await resolveLlm();
      const systemPrompt = params.prompt_path
        ? await readFile(resolve(process.cwd(), params.prompt_path), "utf-8")
        : limited[0]?.systemPrompt ?? "";

      const allResults = new Map<string, {
        policy: { id: string; name: string };
        checked: number;
        passing: number;
        failing: number;
        compliance: number;
        failures: Array<{ conversationId: string; evidence: string }>;
      }>();

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

      for (const conv of limited) {
        const sp = conv.systemPrompt ?? systemPrompt;
        try {
          const policyResults = await checkPolicies(llm, conv, policies, sp);
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
              });
            }
          }
        } catch {
          // Skip conversations that fail evaluation
        }
      }

      for (const entry of allResults.values()) {
        entry.compliance =
          entry.checked > 0
            ? Math.round((entry.passing / entry.checked) * 100)
            : 100;
      }

      const results = Array.from(allResults.values());
      const overallCompliance =
        results.length > 0
          ? results.reduce((sum, r) => sum + r.compliance, 0) / results.length
          : 100;

      const passed =
        params.threshold === undefined || overallCompliance >= params.threshold;

      const usage = llm.getUsage();

      return jsonResult({
        policies: results.map((r) => ({
          ...r,
          failures: r.failures.slice(0, 5), // Limit examples per policy
        })),
        summary: {
          checked: limited.length,
          overallCompliance: Math.round(overallCompliance),
          threshold: params.threshold ?? null,
          passed,
          totalFailures: results.reduce((sum, r) => sum + r.failing, 0),
        },
        cost: {
          calls: usage.calls,
          tokens: usage.inputTokens + usage.outputTokens,
        },
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // 7. triage_analyze — Full analysis pipeline
  // -------------------------------------------------------------------------
  server.registerTool("triage_analyze", {
    title: "Agent Triage: Full Analysis",
    description:
      "Run full evaluation: 12 quality metrics + policy compliance + diagnosis + fixes + recommendations. " +
      "High LLM cost. Writes report.json and report.html to output directory. " +
      "Use quick=true to skip diagnosis and fixes (~60% cheaper). " +
      "If no policies.json exists, auto-discovers agents and extracts policies from traces.",
    inputSchema: {
      traces: z.string().optional().describe("Path to JSON traces file"),
      langsmith: z.string().optional().describe("LangSmith project name"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file"),
      policies_path: z.string().optional().describe("Path to policies.json"),
      prompt_path: z.string().optional().describe("Path to system prompt file"),
      since: z.string().optional().describe("Only include traces after this time (e.g. 2h, 24h, 7d)"),
      until: z.string().optional().describe("Only include traces before this time"),
      agent: z.string().optional().describe("Filter to a specific agent by name"),
      max_conversations: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum conversations to evaluate (default: 500)"),
      quick: z
        .boolean()
        .optional()
        .describe("Skip diagnosis and fix generation (faster, ~60% cheaper)"),
      output_dir: z
        .string()
        .optional()
        .describe("Output directory for report files (default: current directory)"),
    },
    annotations: { readOnlyHint: false },
  }, async (params) => {
    try {
      const startTime = Date.now();

      // Ingest traces
      const conversations = await ingestTraces(params);
      const filtered = applyFilters(conversations, {
        since: params.langsmith ? undefined : params.since,
        until: params.langsmith ? undefined : params.until,
        agent: params.agent,
      });

      const maxConvs = params.max_conversations ?? 500;
      const limited = filtered.slice(0, maxConvs);

      if (limited.length === 0) {
        return errorResult("No conversations found matching filters.");
      }

      // Resolve policies
      const policiesPath = resolve(
        process.cwd(),
        params.policies_path ?? "policies.json",
      );
      const hasPoliciesFile = existsSync(policiesPath);

      let policies: Policy[];
      let systemPrompt = "";
      let policiesHash: string;

      if (hasPoliciesFile) {
        const policiesRaw = await readFile(policiesPath, "utf-8");
        policies = PoliciesFileSchema.parse(JSON.parse(policiesRaw));
        policiesHash = computePoliciesHash(policiesRaw);
      } else {
        const llm = await resolveLlm();
        const discovery = await autoExtractPolicies(llm, limited);
        policies = discovery.policies;
        systemPrompt = discovery.systemPrompt;

        if (policies.length === 0) {
          return errorResult(
            "Auto-discovery could not extract any policies. Run triage_init with a system prompt first.",
          );
        }

        await writeFile(policiesPath, JSON.stringify(policies, null, 2), "utf-8");
        policiesHash = computePoliciesHash(JSON.stringify(policies));
      }

      // Load system prompt from file if provided
      if (params.prompt_path) {
        systemPrompt = await readFile(
          resolve(process.cwd(), params.prompt_path),
          "utf-8",
        );
      }

      // Resolve LLM
      const config = await loadConfig({ prompt: { path: params.prompt_path ?? "." } });
      const apiKey = resolveApiKey(config);
      const llm = createLlmClient(
        config.llm.provider,
        apiKey,
        config.llm.model,
        config.llm.baseUrl,
      );

      // Get system prompt from conversations if not available
      if (!systemPrompt) {
        for (const conv of limited) {
          if (conv.systemPrompt) {
            systemPrompt = conv.systemPrompt;
            break;
          }
        }
      }

      // Check for previous progress
      const previousResults = await loadProgress(policiesHash);

      // Step 1: Evaluate all conversations
      const results = await evaluateAll(llm, limited, policies, systemPrompt, {
        concurrency: config.llm.maxConcurrency,
        policiesHash,
        previousResults: previousResults ?? undefined,
      });

      // Step 2: Aggregate failure patterns
      const failurePatterns = aggregateFailurePatterns(results);
      const totalFailures = failurePatterns.reduce((s, p) => s + p.count, 0);

      // Steps 3-5: Skip in quick mode
      let fixes = new Map<string, { fix: string; blastRadius: string[] }>();
      let recommendations: Report["failurePatterns"]["topRecommendations"] = [];

      if (!params.quick) {
        await generateDiagnoses(llm, results, limited, systemPrompt);

        fixes = await generateFixes(llm, policies, results, failurePatterns);

        try {
          recommendations = await generateRecommendations(
            llm,
            failurePatterns,
            policies,
            results,
          );
        } catch {
          // Non-fatal: continue without recommendations
        }
      }

      // Step 6: Aggregate and build report
      const aggregated = aggregatePolicies(policies, results);
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
        agentTriageVersion: "0.1.0",
        llmProvider: config.llm.provider,
        llmModel: config.llm.model,
        policiesHash,
        agent: {
          name: config.agent?.name ?? "AI Agent",
          promptPath: params.prompt_path ?? "",
          promptContent: systemPrompt || undefined,
        },
        generatedAt: new Date().toISOString(),
        runDuration,
        totalConversations: results.length,
        policies: aggregated.map((p) => ({
          ...p,
          blastRadius: p.blastRadius,
        })),
        conversations: results,
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

      // Write report files
      const outputDir = resolve(process.cwd(), params.output_dir ?? ".");
      const reportPath = resolve(outputDir, "report.json");
      await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

      const htmlPath = resolve(outputDir, "report.html");
      const html = buildHtml(report);
      await writeFile(htmlPath, html, "utf-8");

      await cleanupProgress();

      // Return summary (not the entire report)
      return jsonResult({
        totalConversations: results.length,
        overallCompliance,
        totalFailures,
        metricSummary,
        worstPolicies: aggregated
          .filter((p) => p.failing > 0)
          .sort((a, b) => a.complianceRate - b.complianceRate)
          .slice(0, 5)
          .map((p) => ({
            id: p.id,
            name: p.name,
            compliance: p.complianceRate,
            failing: p.failing,
            total: p.total,
            fix: p.fix,
          })),
        recommendations: recommendations.slice(0, 3).map((r) => ({
          title: r.title,
          description: r.description,
          affectedConversations: r.affectedConversations,
        })),
        reportPath,
        htmlPath,
        duration: `${Math.round(runDuration)}s`,
        cost: {
          tokens: totalTokens,
          estimated: `$${cost.toFixed(4)}`,
        },
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });
}

// ---------------------------------------------------------------------------
// Shared helpers for tool handlers
// ---------------------------------------------------------------------------

function averageMetrics(metrics: Record<string, number>): number {
  const values = Object.values(metrics);
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function formatExplanation(result: ConversationResult) {
  const d = result.diagnosis;
  const failingPolicies = result.policyResults
    .filter((pr) => !pr.passed)
    .map((pr) => ({
      policyId: pr.policyId,
      evidence: pr.evidence,
      failingTurns: pr.failingTurns,
      failureType: pr.failureType,
    }));

  return {
    conversationId: result.id,
    metrics: result.metrics,
    failingPolicies,
    diagnosis: d
      ? {
          severity: d.severity,
          confidence: d.confidence,
          rootCauseTurn: d.rootCauseTurn,
          rootCauseAgent: d.rootCauseAgent,
          summary: d.summary,
          impact: d.impact,
          cascadeChain: d.cascadeChain,
          failureType: d.failureType,
          failureSubtype: d.failureSubtype,
          fix: d.fix,
          blastRadius: d.blastRadius,
        }
      : null,
    turnCount: result.messages.length,
    timeline: result.messages.map((msg, i) => ({
      turn: i + 1,
      role: msg.role,
      content: msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content,
      isRootCause: d ? i + 1 === d.rootCauseTurn : false,
      isViolation: failingPolicies.some((fp) => fp.failingTurns?.includes(i + 1)),
    })),
  };
}

async function generateDiagnosisForResult(
  llm: LlmClient,
  result: ConversationResult,
  systemPrompt: string,
): Promise<Diagnosis | undefined> {
  const transcript = result.messages
    .map((msg, i) => `Turn ${i + 1} [${msg.role}]: ${msg.content}`)
    .join("\n\n");

  const prompt = buildDiagnosisPrompt(systemPrompt, transcript, result.policyResults);

  try {
    const response = await llm.call(prompt, { temperature: 0.3, maxTokens: 2048 });
    const parsed = parseJsonResponse(response.content) as Record<string, unknown>;

    return {
      rootCauseTurn: Number(parsed.rootCauseTurn ?? 1),
      rootCauseAgent: parsed.rootCauseAgent ? String(parsed.rootCauseAgent) : null,
      summary: String(parsed.summary ?? ""),
      impact: String(parsed.impact ?? ""),
      cascadeChain: Array.isArray(parsed.cascadeChain) ? parsed.cascadeChain.map(String) : [],
      fix: String(parsed.fix ?? ""),
      severity: validateEnum(parsed.severity, ["critical", "major", "minor"], "major") as Diagnosis["severity"],
      confidence: validateEnum(parsed.confidence, ["high", "medium", "low"], "medium") as Diagnosis["confidence"],
      failureType: validateEnum(parsed.failureType, ["prompt_issue", "orchestration_issue", "model_limitation", "retrieval_rag_issue"], "prompt_issue") as Diagnosis["failureType"],
      failureSubtype: String(parsed.failureSubtype ?? ""),
      blastRadius: Array.isArray(parsed.blastRadius) ? parsed.blastRadius.map(String) : [],
    };
  } catch {
    return undefined;
  }
}

function validateEnum(val: unknown, valid: string[], fallback: string): string {
  const s = String(val).toLowerCase();
  return valid.includes(s) ? s : fallback;
}
