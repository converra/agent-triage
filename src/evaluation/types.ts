import { z } from "zod";
import type { Policy } from "../policy/types.js";
import type { NormalizedConversation } from "../ingestion/types.js";

export const MetricScoresSchema = z.object({
  successScore: z.number().min(0).max(100),
  aiRelevancy: z.number().min(0).max(100),
  sentiment: z.number().min(0).max(100),
  hallucinationScore: z.number().min(0).max(100),
  repetitionScore: z.number().min(0).max(100),
  consistencyScore: z.number().min(0).max(100),
  naturalLanguageScore: z.number().min(0).max(100),
  contextRetentionScore: z.number().min(0).max(100),
  verbosityScore: z.number().min(0).max(100),
  taskCompletion: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
  truncationScore: z.number().min(0).max(100),
});

export type MetricScores = z.infer<typeof MetricScoresSchema>;

export const METRIC_NAMES: (keyof MetricScores)[] = [
  "successScore",
  "aiRelevancy",
  "sentiment",
  "hallucinationScore",
  "repetitionScore",
  "consistencyScore",
  "naturalLanguageScore",
  "contextRetentionScore",
  "verbosityScore",
  "taskCompletion",
  "clarity",
  "truncationScore",
];

export const FailureTypeSchema = z.enum([
  "prompt_issue",
  "orchestration_issue",
  "model_limitation",
  "retrieval_rag_issue",
]);
export type FailureType = z.infer<typeof FailureTypeSchema>;

export const VerdictSchema = z.enum(["pass", "fail", "not_applicable"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const PolicyResultSchema = z.object({
  policyId: z.string(),
  verdict: VerdictSchema,
  // Backward compat: passed = verdict === "pass" (true for both pass and not_applicable in legacy consumers)
  passed: z.boolean(),
  evidence: z.string(),
  failingTurns: z.array(z.number()).optional(),
  failureType: FailureTypeSchema.nullable().optional(),
  failureSubtype: z.string().nullable().optional(),
});
export type PolicyResult = z.infer<typeof PolicyResultSchema>;

export interface Diagnosis {
  rootCauseTurn: number;
  rootCauseAgent: string | null;
  shortSummary: string;
  summary: string;
  impact: string;
  cascadeChain: string[];
  fix: string;
  severity: "critical" | "major" | "minor";
  confidence: "high" | "medium" | "low";
  failureType: FailureType;
  failureSubtype: string;
  blastRadius: string[];
  turnDescriptions?: Record<number, string>;
}

export interface ConversationResult {
  id: string;
  metrics: MetricScores;
  policyResults: PolicyResult[];
  diagnosis?: Diagnosis;
  messages: NormalizedConversation["messages"];
}

export interface FailurePattern {
  type: FailureType;
  count: number;
  criticalCount: number;
  subtypes: Array<{ name: string; count: number; percentage: number }>;
}

export interface AgentSummary {
  name: string;
  conversationCount: number;
  policiesEvaluated: number;
  compliance: number;
  topFailingPolicies: Array<{ id: string; name: string; complianceRate: number }>;
}

export interface Report {
  agentTriageVersion: string;
  llmProvider: string;
  llmModel: string;
  policiesHash: string;
  agent: { name: string; promptPath: string; promptContent?: string };
  agents: AgentSummary[];
  generatedAt: string;
  runDuration: number;
  totalConversations: number;
  policies: Array<
    Policy & {
      passing: number;
      failing: number;
      notApplicable: number;
      evaluated: number;
      total: number;
      complianceRate: number;
      fix?: string;
      blastRadius?: string[];
      failingConversationIds: string[];
    }
  >;
  conversations: ConversationResult[];
  failurePatterns: {
    byType: FailurePattern[];
    topRecommendations: Array<{
      title: string;
      description: string;
      targetFailureTypes: string[];
      targetSubtypes: string[];
      affectedConversations: number;
      confidence: string;
      howToApply?: string;
    }>;
    totalFailures: number;
  };
  metricSummary: Record<string, number>;
  overallCompliance: number;
  cost: { totalTokens: number; estimatedCost: number };
}
