// Public API — importable when used as a library
export { readJsonTraces } from "./ingestion/json.js";
export { readLangSmithTraces } from "./ingestion/langsmith.js";
export { readOtelTraces, OTEL_SEMCONV_VERSION } from "./ingestion/otel.js";
export { autoExtractPolicies, discoverAgents } from "./ingestion/auto-discovery.js";
export type { DiscoveredAgent, DiscoveryResult } from "./ingestion/auto-discovery.js";
export type { NormalizedConversation, Message } from "./ingestion/types.js";

export { extractPolicies } from "./policy/extractor.js";
export type { Policy } from "./policy/types.js";

export { createLlmClient } from "./llm/client.js";
export type { LlmClient, LlmCallOptions, LlmResponse, TokenUsage } from "./llm/client.js";

export { evaluateConversation } from "./evaluation/evaluator.js";
export { checkPolicies } from "./evaluation/policy-checker.js";
export { evaluateAll } from "./evaluation/runner.js";
export { generateDiagnoses } from "./evaluation/diagnosis.js";
export { generateFixes, generateRecommendations } from "./evaluation/fix-generator.js";
export type {
  MetricScores,
  PolicyResult,
  Diagnosis,
  ConversationResult,
  FailurePattern,
  FailureType,
  Report,
} from "./evaluation/types.js";

export {
  aggregatePolicies,
  aggregateFailurePatterns,
  calculateMetricSummary,
  calculateOverallCompliance,
} from "./aggregation/policy-aggregator.js";

export { buildHtml, generateHtmlReport } from "./report/generator.js";
export { diffReports, formatDiffTerminal } from "./diff/diff.js";
export type { PolicyDiff, DiffResult } from "./diff/diff.js";

export { loadConfig, resolveApiKey } from "./config/loader.js";
export type { Config, LlmProvider, TraceSource } from "./config/schema.js";
export { estimateCost, COST_PER_1K_TOKENS } from "./config/defaults.js";

export { parseJsonResponse } from "./llm/json.js";

export { applyFilters, parseDuration, createLogger } from "./cli/filters.js";
export type { FilterSpec } from "./cli/filters.js";
