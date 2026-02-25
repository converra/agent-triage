import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { diffReports, applyFilters } from "../index.js";
import type { Report } from "../index.js";
import {
  jsonResult,
  errorResult,
  ingestTraces,
  filterByQuery,
  loadPoliciesFromFile,
} from "./helpers.js";

/**
 * Register zero-cost read-only tools: status, sample, list_policies, diff.
 * These tools read files or trace sources but never call an LLM.
 */
export function registerReadTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // triage_status — Zero-cost health check from existing report
  // -------------------------------------------------------------------------
  server.registerTool("triage_status", {
    title: "Agent Triage: Status",
    description:
      "Quick health check from the last analysis report. Zero LLM cost — reads report.json from disk. " +
      "Returns overall compliance, worst policies, critical issues, and a suggested next step. " +
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

    const report = JSON.parse(await readFile(reportPath, "utf-8")) as Report;

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

    let nextStep: string;
    if (ageDays >= 1) {
      nextStep = "Report is stale. Use triage_sample to inspect recent conversations, or triage_analyze to refresh.";
    } else if (criticalCount > 0) {
      nextStep = "Critical issues found. Use triage_explain with worst=true to diagnose the worst failure.";
    } else if (worstPolicies.length > 0) {
      nextStep = `Failing policies found. Use triage_sample with query keywords related to "${worstPolicies[0].name}" to inspect conversations, then triage_explain on specific failures.`;
    } else {
      nextStep = "All policies passing. Agent looks healthy.";
    }

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
      nextStep,
    });
  });

  // -------------------------------------------------------------------------
  // triage_sample — Browse raw conversations (zero LLM cost)
  // -------------------------------------------------------------------------
  server.registerTool("triage_sample", {
    title: "Agent Triage: Sample Traces",
    description:
      "Fetch a small sample of recent conversations for inspection. Zero LLM cost. " +
      "Use this to look at raw conversation data before running expensive analysis. " +
      "Supports keyword search on message content to find conversations about specific topics. " +
      "This is the key tool for narrowing from 'something is wrong' to 'these conversations show the problem'.",
    inputSchema: {
      traces: z.string().optional().describe("Path to JSON traces file"),
      langsmith: z.string().optional().describe("LangSmith project name"),
      otel: z.string().optional().describe("Path to OTLP/JSON export file"),
      since: z.string().optional().describe("Time window start (e.g. 24h, 7d). Default: all"),
      until: z.string().optional().describe("Time window end"),
      agent: z.string().optional().describe("Filter by agent name"),
      query: z
        .string()
        .optional()
        .describe("Search query — filters to conversations containing this text in any message (case-insensitive)"),
      conversation_ids: z
        .array(z.string())
        .optional()
        .describe("Fetch specific conversations by ID (overrides sampling)"),
      sample_size: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of conversations to return (default: 5)"),
      sort: z
        .enum(["recent", "oldest", "longest", "shortest"])
        .optional()
        .describe("Sort order (default: recent)"),
    },
    annotations: { readOnlyHint: true },
  }, async (params) => {
    try {
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

      const sortBy = params.sort ?? "recent";
      switch (sortBy) {
        case "recent":
          conversations.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          break;
        case "oldest":
          conversations.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
          break;
        case "longest":
          conversations.sort((a, b) => b.messages.length - a.messages.length);
          break;
        case "shortest":
          conversations.sort((a, b) => a.messages.length - b.messages.length);
          break;
      }

      const sampleSize = params.sample_size ?? 5;
      const sampled = conversations.slice(0, sampleSize);

      return jsonResult({
        totalMatching: conversations.length,
        returned: sampled.length,
        query: params.query ?? null,
        conversations: sampled.map((c) => ({
          id: c.id,
          timestamp: c.timestamp,
          agentName: c.metadata.agentName ?? null,
          model: c.metadata.model ?? null,
          turnCount: c.messages.length,
          duration: c.metadata.duration ?? null,
          systemPrompt: c.systemPrompt
            ? c.systemPrompt.length > 200
              ? c.systemPrompt.slice(0, 200) + "..."
              : c.systemPrompt
            : null,
          messages: c.messages.map((m) => ({
            role: m.role,
            content: m.content.length > 500
              ? m.content.slice(0, 500) + "..."
              : m.content,
          })),
        })),
      });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  // -------------------------------------------------------------------------
  // triage_list_policies — List loaded policies
  // -------------------------------------------------------------------------
  server.registerTool("triage_list_policies", {
    title: "Agent Triage: List Policies",
    description:
      "List all behavioral policies from policies.json. Zero LLM cost. " +
      "Returns policy IDs, names, descriptions, categories, and complexity scores. " +
      "Use this to map a problem description to specific policy IDs for targeted checking.",
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
  // triage_diff — Compare two reports
  // -------------------------------------------------------------------------
  server.registerTool("triage_diff", {
    title: "Agent Triage: Diff Reports",
    description:
      "Compare two report.json files to see what changed between runs. Zero LLM cost. " +
      "Returns per-policy compliance changes, new/resolved failures, and metric deltas. " +
      "Use after a prompt change to verify the fix worked and check for regressions.",
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
}
