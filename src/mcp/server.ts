import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools-read.js";
import { registerEvalTools } from "./tools-eval.js";

/**
 * Register all MCP tools on the server.
 *
 * Tools are organized by cost and purpose:
 * - Read tools (zero LLM cost): status, sample, list_policies, diff
 * - Eval tools (LLM cost): init, explain, check, analyze
 *
 * The intended debugging workflow is:
 * 1. triage_status → understand current health
 * 2. triage_sample → look at raw conversations (with keyword search)
 * 3. triage_list_policies → find relevant policy IDs
 * 4. triage_check → targeted policy compliance on specific conversations
 * 5. triage_explain → root cause diagnosis of worst failures
 * 6. (fix the prompt)
 * 7. triage_analyze → re-run full evaluation
 * 8. triage_diff → verify improvement
 */
export function registerTools(server: McpServer): void {
  registerReadTools(server);
  registerEvalTools(server);
}
