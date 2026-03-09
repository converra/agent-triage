import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
  autoExtractPolicies,
  loadConfig,
  resolveApiKey,
  estimateCost,
  applyFilters,
} from "../index.js";

import type { Policy, Report } from "../index.js";
import type { ConversationResult } from "../evaluation/types.js";

import { PoliciesFileSchema } from "../policy/types.js";
import { computePoliciesHash, loadProgress, cleanupProgress } from "../evaluation/progress.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };

import {
  jsonResult,
  errorResult,
  resolveLlm,
  ingestTraces,
  filterByQuery,
  loadPoliciesFromFile,
  averageMetrics,
  formatExplanation,
  generateDiagnosisForResult,
  safePath,
} from "./helpers.js";

/**
 * Register LLM-cost tools: init, explain, check, analyze.
 * These tools call an LLM and incur token costs.
 */
export function registerEvalTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // triage_init — Extract policies from a system prompt
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
        safePath(prompt_path),
        "utf-8",
      );

      const llm = await resolveLlm();
      const policies = await extractPolicies(llm, promptContent);

      const outPath = safePath(output_path ?? "policies.json");
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
  // triage_explain — Deep-dive into a single conversation
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
      traces: z.string().optional().describe("Path to JSON traces file (recommended — instant, flexible format)"),
      langsmith: z.string().optional().describe("LangSmith project name (alternative — requires API key, slower)"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file (alternative)"),
      axiom: z.string().optional().describe("Axiom dataset name (alternative — requires AXIOM_API_KEY env var)"),
      axiom_org_id: z.string().optional().describe("Axiom org ID (for personal access tokens)"),
      langfuse: z.boolean().optional().describe("Use Langfuse as trace source (requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars)"),
      langfuse_public_key: z.string().optional().describe("Langfuse public key (or set LANGFUSE_PUBLIC_KEY)"),
      langfuse_secret_key: z.string().optional().describe("Langfuse secret key (or set LANGFUSE_SECRET_KEY)"),
      langfuse_host: z.string().optional().describe("Langfuse host (default: https://cloud.langfuse.com)"),
      policies_path: z.string().optional().describe("Path to policies.json"),
      prompt_path: z.string().optional().describe("Path to system prompt file"),
    },
  }, async (params) => {
    try {
      const reportDir = safePath(params.report_dir ?? ".");
      const reportPath = resolve(reportDir, "report.json");
      const hasReport = existsSync(reportPath);

      // Require explicit worst=true or a conversation_id
      if (!params.worst && !params.conversation_id) {
        return errorResult(
          "Provide a conversation_id to explain, or use worst=true to diagnose the worst failing conversation.",
        );
      }

      // --worst: find worst from report
      if (params.worst) {
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

        const llm = await resolveLlm();
        const diagnosis = await generateDiagnosisForResult(
          llm,
          worst,
          report.agent.promptContent ?? "",
        );
        if (diagnosis) worst.diagnosis = diagnosis;
        return jsonResult(formatExplanation(worst));
      }

      // Specific conversation ID — check report first
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
      const policiesPath = safePath(params.policies_path ?? "policies.json");
      let policies: Policy[] = [];
      if (existsSync(policiesPath)) {
        const raw = await readFile(policiesPath, "utf-8");
        policies = PoliciesFileSchema.parse(JSON.parse(raw));
      }

      const systemPrompt = params.prompt_path
        ? await readFile(safePath(params.prompt_path), "utf-8")
        : conv.systemPrompt ?? "";

      const { evaluateConversation } = await import("../evaluation/evaluator.js");
      const [metrics, policyResults] = await Promise.all([
        evaluateConversation(llm, conv, systemPrompt),
        policies.length > 0
          ? checkPolicies(llm, conv, policies, systemPrompt)
          : Promise.resolve([]),
      ]);

      const result: ConversationResult = { id: conv.id, metrics, policyResults, messages: conv.messages };

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
  // triage_check — Targeted policy compliance check
  // -------------------------------------------------------------------------
  server.registerTool("triage_check", {
    title: "Agent Triage: Check Policies",
    description:
      "Run policy compliance checks against traces (no metrics — faster and cheaper than full analyze). " +
      "Moderate LLM cost. Returns per-policy compliance rates with failing examples. " +
      "Provide a JSON traces file (recommended) or a LangSmith/OTel source. " +
      "Use policy_ids to focus on specific policies. Use query to narrow to conversations about a topic. " +
      "Use conversation_ids to check specific conversations found via triage_sample.",
    inputSchema: {
      traces: z.string().optional().describe("Path to JSON traces file (recommended — instant, flexible format)"),
      langsmith: z.string().optional().describe("LangSmith project name (alternative — requires API key, slower)"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file (alternative)"),
      axiom: z.string().optional().describe("Axiom dataset name (alternative — requires AXIOM_API_KEY env var)"),
      axiom_org_id: z.string().optional().describe("Axiom org ID (for personal access tokens)"),
      langfuse: z.boolean().optional().describe("Use Langfuse as trace source (requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars)"),
      langfuse_public_key: z.string().optional().describe("Langfuse public key (or set LANGFUSE_PUBLIC_KEY)"),
      langfuse_secret_key: z.string().optional().describe("Langfuse secret key (or set LANGFUSE_SECRET_KEY)"),
      langfuse_host: z.string().optional().describe("Langfuse host (default: https://cloud.langfuse.com)"),
      policies_path: z.string().optional().describe("Path to policies.json"),
      policy_ids: z
        .array(z.string())
        .optional()
        .describe("Specific policy IDs to check (default: all)"),
      prompt_path: z.string().optional().describe("Path to system prompt file"),
      since: z.string().optional().describe("Only include traces after this time (e.g. 2h, 24h, 7d)"),
      until: z.string().optional().describe("Only include traces before this time"),
      agent: z.string().optional().describe("Filter to a specific agent by name"),
      query: z
        .string()
        .optional()
        .describe("Filter to conversations containing this text in any message (case-insensitive)"),
      conversation_ids: z
        .array(z.string())
        .optional()
        .describe("Check specific conversations by ID (e.g. from triage_sample results)"),
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
    annotations: { readOnlyHint: false },
  }, async (params) => {
    try {
      let policies = loadPoliciesFromFile(params.policies_path);

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

      let conversations = await ingestTraces(params);
      conversations = applyFilters(conversations, {
        since: params.langsmith ? undefined : params.since,
        until: params.langsmith ? undefined : params.until,
        agent: params.agent,
      });

      if (params.query) {
        conversations = filterByQuery(conversations, params.query);
      }

      if (params.conversation_ids && params.conversation_ids.length > 0) {
        const ids = new Set(params.conversation_ids);
        conversations = conversations.filter((c) => ids.has(c.id));
      }

      const maxConvs = params.max_conversations ?? 500;
      const limited = conversations.slice(0, maxConvs);

      if (limited.length === 0) {
        return errorResult("No conversations found matching filters.");
      }

      const llm = await resolveLlm();
      const systemPrompt = params.prompt_path
        ? await readFile(safePath(params.prompt_path), "utf-8")
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
          checked: 0, passing: 0, failing: 0, compliance: 100, failures: [],
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
              entry.failures.push({ conversationId: conv.id, evidence: pr.evidence });
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
        policies: results.map((r) => ({ ...r, failures: r.failures.slice(0, 5) })),
        summary: {
          checked: limited.length,
          overallCompliance: Math.round(overallCompliance),
          threshold: params.threshold ?? null,
          passed,
          totalFailures: results.reduce((sum, r) => sum + r.failing, 0),
        },
        cost: { calls: usage.calls, tokens: usage.inputTokens + usage.outputTokens },
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // triage_analyze — Full analysis pipeline
  // -------------------------------------------------------------------------
  server.registerTool("triage_analyze", {
    title: "Agent Triage: Full Analysis",
    description:
      "Run full evaluation: 12 quality metrics + policy compliance + diagnosis + fixes + recommendations. " +
      "High LLM cost. Writes report.json and report.html to output directory. " +
      "Provide a JSON traces file (recommended) or a LangSmith/OTel source. " +
      "Use quick=true to skip diagnosis and fixes (~60% cheaper). " +
      "If no policies.json exists, auto-discovers agents and extracts policies from traces.",
    inputSchema: {
      traces: z.string().optional().describe("Path to JSON traces file (recommended — instant, flexible format)"),
      langsmith: z.string().optional().describe("LangSmith project name (alternative — requires API key, slower)"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file (alternative)"),
      axiom: z.string().optional().describe("Axiom dataset name (alternative — requires AXIOM_API_KEY env var)"),
      axiom_org_id: z.string().optional().describe("Axiom org ID (for personal access tokens)"),
      langfuse: z.boolean().optional().describe("Use Langfuse as trace source (requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars)"),
      langfuse_public_key: z.string().optional().describe("Langfuse public key (or set LANGFUSE_PUBLIC_KEY)"),
      langfuse_secret_key: z.string().optional().describe("Langfuse secret key (or set LANGFUSE_SECRET_KEY)"),
      langfuse_host: z.string().optional().describe("Langfuse host (default: https://cloud.langfuse.com)"),
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

      // Resolve LLM — single client for both auto-discovery and evaluation
      const config = await loadConfig({ prompt: { path: params.prompt_path ?? "." } });
      const apiKey = resolveApiKey(config);
      const llm = createLlmClient(config.llm.provider, apiKey, config.llm.model, config.llm.baseUrl);

      // Resolve policies
      const policiesPath = safePath(params.policies_path ?? "policies.json");
      const hasPoliciesFile = existsSync(policiesPath);

      let policies: Policy[];
      let systemPrompt = "";
      let policiesHash: string;

      if (hasPoliciesFile) {
        const policiesRaw = await readFile(policiesPath, "utf-8");
        policies = PoliciesFileSchema.parse(JSON.parse(policiesRaw));
        policiesHash = computePoliciesHash(policiesRaw);
      } else {
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

      if (params.prompt_path) {
        systemPrompt = await readFile(safePath(params.prompt_path), "utf-8");
      }

      if (!systemPrompt) {
        for (const conv of limited) {
          if (conv.systemPrompt) { systemPrompt = conv.systemPrompt; break; }
        }
      }

      const previousResults = await loadProgress(policiesHash);

      // Step 1: Evaluate
      const results = await evaluateAll(llm, limited, policies, systemPrompt, {
        concurrency: config.llm.maxConcurrency,
        policiesHash,
        previousResults: previousResults ?? undefined,
      });

      // Step 2: Aggregate
      const failurePatterns = aggregateFailurePatterns(results);
      const totalFailures = failurePatterns.reduce((s, p) => s + p.count, 0);

      // Steps 3-5: Skip in quick mode
      let fixes = new Map<string, { fix: string; blastRadius: string[] }>();
      let recommendations: Report["failurePatterns"]["topRecommendations"] = [];

      if (!params.quick) {
        await generateDiagnoses(llm, results, limited, systemPrompt);
        fixes = await generateFixes(llm, policies, results, failurePatterns);
        try {
          recommendations = await generateRecommendations(llm, failurePatterns, policies, results);
        } catch { /* non-fatal */ }
      }

      // Step 6: Build report
      const aggregated = aggregatePolicies(policies, results);
      const metricSummary = calculateMetricSummary(results);
      const overallCompliance = calculateOverallCompliance(results);

      for (const policy of aggregated) {
        const fixResult = fixes.get(policy.id);
        if (fixResult) { policy.fix = fixResult.fix; policy.blastRadius = fixResult.blastRadius; }
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
          promptPath: params.prompt_path ?? "",
          promptContent: systemPrompt || undefined,
        },
        agents: [],
        generatedAt: new Date().toISOString(),
        runDuration,
        totalConversations: results.length,
        policies: aggregated.map((p) => ({ ...p, blastRadius: p.blastRadius })),
        conversations: results,
        failurePatterns: { byType: failurePatterns, topRecommendations: recommendations, totalFailures },
        metricSummary,
        overallCompliance,
        cost: { totalTokens, estimatedCost: cost },
      };

      const outputDir = safePath(params.output_dir ?? ".");
      const reportPath = resolve(outputDir, "report.json");
      await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

      const htmlPath = resolve(outputDir, "report.html");
      await writeFile(htmlPath, buildHtml(report), "utf-8");
      await cleanupProgress();

      const { appendHistory } = await import("../history.js");
      await appendHistory(report, outputDir);

      return jsonResult({
        totalConversations: results.length,
        overallCompliance,
        totalFailures,
        metricSummary,
        worstPolicies: aggregated
          .filter((p) => p.failing > 0)
          .sort((a, b) => a.complianceRate - b.complianceRate)
          .slice(0, 5)
          .map((p) => ({ id: p.id, name: p.name, compliance: p.complianceRate, failing: p.failing, total: p.total, fix: p.fix })),
        recommendations: recommendations.slice(0, 3).map((r) => ({
          title: r.title, description: r.description, affectedConversations: r.affectedConversations,
        })),
        reportPath,
        htmlPath,
        duration: `${Math.round(runDuration)}s`,
        cost: { tokens: totalTokens, estimated: `$${cost.toFixed(4)}` },
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });
}
