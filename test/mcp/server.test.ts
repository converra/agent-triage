import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/mcp/server.js";
import { makeResult, VALID_METRICS } from "../helpers.js";
import type { Report } from "../../src/evaluation/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSampleReport(overrides?: Partial<Report>): Report {
  return {
    agentTriageVersion: "0.1.0",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    policiesHash: "abc123",
    agent: { name: "Test Agent", promptPath: "" },
    generatedAt: new Date().toISOString(),
    runDuration: 10,
    totalConversations: 2,
    policies: [
      {
        id: "greet",
        name: "Greet user",
        description: "Always greet",
        complexity: 1,
        category: "behavior",
        passing: 1,
        failing: 1,
        total: 2,
        complianceRate: 50,
        failingConversationIds: ["conv-2"],
      },
    ],
    conversations: [
      makeResult("conv-1"),
      makeResult("conv-2", {
        policyResults: [
          { policyId: "greet", passed: false, evidence: "No greeting", failingTurns: [1] },
        ],
        diagnosis: {
          rootCauseTurn: 1,
          rootCauseAgent: null,
          summary: "Missing greeting",
          impact: "Bad UX",
          cascadeChain: ["User confused"],
          fix: "Add greeting to prompt",
          severity: "major",
          confidence: "high",
          failureType: "prompt_issue",
          failureSubtype: "tone_violation",
          blastRadius: [],
        },
      }),
    ],
    failurePatterns: {
      byType: [{ type: "prompt_issue", count: 1, criticalCount: 0, subtypes: [] }],
      topRecommendations: [
        {
          title: "Add greeting",
          description: "Add a greeting to the system prompt.",
          targetFailureTypes: ["prompt_issue"],
          targetSubtypes: ["tone_violation"],
          affectedConversations: 1,
          confidence: "high",
        },
      ],
      totalFailures: 1,
    },
    metricSummary: { ...VALID_METRICS },
    overallCompliance: 50,
    cost: { totalTokens: 1000, estimatedCost: 0.01 },
    ...overrides,
  };
}

function makeSamplePolicies() {
  return [
    {
      id: "greet",
      name: "Greet user",
      description: "Always greet the user warmly.",
      complexity: 1,
      category: "behavior",
    },
    {
      id: "escalate",
      name: "Escalate billing",
      description: "Escalate billing disputes to human.",
      complexity: 3,
      category: "routing",
    },
  ];
}

// ---------------------------------------------------------------------------
// Helper: connect a client to the MCP server via in-memory transport
// ---------------------------------------------------------------------------

async function createTestClient(): Promise<Client> {
  const server = new McpServer({ name: "agent-triage-test", version: "0.1.0" });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return client;
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const textContent = result.content as Array<{ type: string; text: string }>;
  const text = textContent.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Server", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `agent-triage-mcp-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("tool registration", () => {
    it("registers all 10 tools", async () => {
      const client = await createTestClient();
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "triage_analyze",
        "triage_check",
        "triage_demo",
        "triage_diff",
        "triage_explain",
        "triage_history",
        "triage_init",
        "triage_list_policies",
        "triage_sample",
        "triage_status",
        "triage_view",
      ]);
    });

    it("all tools have descriptions", async () => {
      const client = await createTestClient();
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.description!.length).toBeGreaterThan(20);
      }
    });
  });

  describe("triage_status", () => {
    it("returns error when no report exists", async () => {
      const client = await createTestClient();
      const result = await client.callTool({ name: "triage_status", arguments: {} });
      expect(result.isError).toBe(true);
      const parsed = parseResult(result) as { error: string };
      expect(parsed.error).toContain("No report.json found");
    });

    it("returns health summary from existing report", async () => {
      const report = makeSampleReport();
      writeFileSync(join(tmpDir, "report.json"), JSON.stringify(report));

      const client = await createTestClient();
      const result = await client.callTool({ name: "triage_status", arguments: {} });
      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.totalConversations).toBe(2);
      expect(parsed.overallCompliance).toBe(50);
      expect(parsed.totalFailures).toBe(1);
      expect(parsed.age).toBe("just now");
      expect(parsed.stale).toBe(false);
      expect((parsed.worstPolicies as unknown[]).length).toBe(1);
      expect(parsed.nextStep).toBeTruthy();
      expect(typeof parsed.nextStep).toBe("string");
    });

    it("shows stale=true for old reports", async () => {
      const report = makeSampleReport({
        generatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), // 2 days ago
      });
      writeFileSync(join(tmpDir, "report.json"), JSON.stringify(report));

      const client = await createTestClient();
      const result = await client.callTool({ name: "triage_status", arguments: {} });
      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.stale).toBe(true);
      expect(parsed.age).toBe("2d ago");
    });

    it("accepts custom report_dir", async () => {
      const subDir = join(tmpDir, "reports");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "report.json"), JSON.stringify(makeSampleReport()));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_status",
        arguments: { report_dir: "reports" },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe("triage_list_policies", () => {
    it("returns error when no policies.json exists", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_list_policies",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    });

    it("lists policies from policies.json", async () => {
      writeFileSync(
        join(tmpDir, "policies.json"),
        JSON.stringify(makeSamplePolicies()),
      );

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_list_policies",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result) as { count: number; policies: unknown[] };
      expect(parsed.count).toBe(2);
      expect(parsed.policies).toHaveLength(2);
    });

    it("accepts custom policies_path", async () => {
      writeFileSync(
        join(tmpDir, "custom-policies.json"),
        JSON.stringify(makeSamplePolicies()),
      );

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_list_policies",
        arguments: { policies_path: "custom-policies.json" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result) as { count: number };
      expect(parsed.count).toBe(2);
    });
  });

  describe("triage_sample", () => {
    it("returns error when no trace source specified", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_sample",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    });

    it("samples conversations from JSON traces", async () => {
      const traces = [
        {
          id: "conv-1",
          messages: [
            { role: "user", content: "I need a refund for my order" },
            { role: "assistant", content: "I can help with that refund." },
          ],
        },
        {
          id: "conv-2",
          messages: [
            { role: "user", content: "What are your hours?" },
            { role: "assistant", content: "We are open 9-5." },
          ],
        },
        {
          id: "conv-3",
          messages: [
            { role: "user", content: "I want a refund please" },
            { role: "assistant", content: "Sure, processing your refund now." },
          ],
        },
      ];
      writeFileSync(join(tmpDir, "traces.json"), JSON.stringify(traces));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_sample",
        arguments: { traces: "traces.json", sample_size: 2 },
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result) as { totalMatching: number; returned: number; conversations: unknown[] };
      expect(parsed.totalMatching).toBe(3);
      expect(parsed.returned).toBe(2);
      expect(parsed.conversations).toHaveLength(2);
    });

    it("filters by keyword query", async () => {
      const traces = [
        { id: "c1", messages: [{ role: "user", content: "refund my order" }, { role: "assistant", content: "OK" }] },
        { id: "c2", messages: [{ role: "user", content: "what are hours?" }, { role: "assistant", content: "9-5" }] },
        { id: "c3", messages: [{ role: "user", content: "refund please" }, { role: "assistant", content: "done" }] },
      ];
      writeFileSync(join(tmpDir, "traces.json"), JSON.stringify(traces));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_sample",
        arguments: { traces: "traces.json", query: "refund" },
      });

      const parsed = parseResult(result) as { totalMatching: number; conversations: Array<{ id: string }> };
      expect(parsed.totalMatching).toBe(2);
      expect(parsed.conversations.map((c) => c.id).sort()).toEqual(["c1", "c3"]);
    });

    it("fetches specific conversation IDs", async () => {
      const traces = [
        { id: "c1", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] },
        { id: "c2", messages: [{ role: "user", content: "bye" }, { role: "assistant", content: "bye" }] },
      ];
      writeFileSync(join(tmpDir, "traces.json"), JSON.stringify(traces));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_sample",
        arguments: { traces: "traces.json", conversation_ids: ["c2"] },
      });

      const parsed = parseResult(result) as { conversations: Array<{ id: string }> };
      expect(parsed.conversations).toHaveLength(1);
      expect(parsed.conversations[0].id).toBe("c2");
    });

    it("truncates long messages", async () => {
      const longContent = "A".repeat(1000);
      const traces = [
        { id: "c1", messages: [{ role: "user", content: longContent }, { role: "assistant", content: "ok" }] },
      ];
      writeFileSync(join(tmpDir, "traces.json"), JSON.stringify(traces));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_sample",
        arguments: { traces: "traces.json" },
      });

      const parsed = parseResult(result) as { conversations: Array<{ messages: Array<{ content: string }> }> };
      expect(parsed.conversations[0].messages[0].content.length).toBeLessThanOrEqual(504); // 500 + "..."
    });
  });

  describe("triage_diff", () => {
    it("returns diff between two reports", async () => {
      const before = makeSampleReport({ overallCompliance: 50 });
      const after = makeSampleReport({ overallCompliance: 80 });

      writeFileSync(join(tmpDir, "before.json"), JSON.stringify(before));
      writeFileSync(join(tmpDir, "after.json"), JSON.stringify(after));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_diff",
        arguments: { before_path: "before.json", after_path: "after.json" },
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed).toHaveProperty("overallDelta");
    });

    it("returns error for missing files", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_diff",
        arguments: { before_path: "nonexistent.json", after_path: "also-missing.json" },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("triage_explain", () => {
    it("returns explanation from existing report diagnosis", async () => {
      const report = makeSampleReport();
      writeFileSync(join(tmpDir, "report.json"), JSON.stringify(report));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_explain",
        arguments: { worst: true },
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.conversationId).toBe("conv-2");
      expect(parsed.diagnosis).toBeTruthy();
      expect((parsed.diagnosis as Record<string, unknown>).severity).toBe("major");
      expect((parsed.diagnosis as Record<string, unknown>).summary).toBe("Missing greeting");
      expect(parsed.timeline).toBeTruthy();
    });

    it("returns 'all passing' when no failures exist", async () => {
      const report = makeSampleReport({
        conversations: [makeResult("conv-1"), makeResult("conv-2")],
      });
      writeFileSync(join(tmpDir, "report.json"), JSON.stringify(report));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_explain",
        arguments: { worst: true },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result) as { message: string };
      expect(parsed.message).toContain("All policies passing");
    });

    it("returns error when no report and no trace source", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_explain",
        arguments: { conversation_id: "unknown-id" },
      });
      expect(result.isError).toBe(true);
    });

    it("returns explanation for specific conversation by ID", async () => {
      const report = makeSampleReport();
      writeFileSync(join(tmpDir, "report.json"), JSON.stringify(report));

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_explain",
        arguments: { conversation_id: "conv-2" },
      });
      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result) as Record<string, unknown>;
      expect(parsed.conversationId).toBe("conv-2");
    });
  });

  describe("triage_check", () => {
    it("returns error when no trace source specified", async () => {
      writeFileSync(
        join(tmpDir, "policies.json"),
        JSON.stringify(makeSamplePolicies()),
      );

      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_check",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const parsed = parseResult(result) as { error: string };
      expect(parsed.error).toContain("No trace source");
    });

    it("returns error when no policies.json exists", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_check",
        arguments: { traces: "some-file.json" },
      });
      expect(result.isError).toBe(true);
      const parsed = parseResult(result) as { error: string };
      expect(parsed.error).toContain("No policies.json");
    });
  });

  describe("triage_analyze", () => {
    it("returns error when no trace source specified", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_analyze",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const parsed = parseResult(result) as { error: string };
      expect(parsed.error).toContain("No trace source");
    });
  });

  describe("triage_init", () => {
    it("returns error when prompt file doesn't exist", async () => {
      const client = await createTestClient();
      const result = await client.callTool({
        name: "triage_init",
        arguments: { prompt_path: "nonexistent-prompt.txt" },
      });
      expect(result.isError).toBe(true);
    });
  });
});
