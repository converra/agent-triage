import type { Policy } from "../policy/types.js";

/**
 * Prompt 1: Policy Extraction
 * Input: system prompt text
 * Output: JSON array of policies
 */
export function buildPolicyExtractionPrompt(systemPrompt: string): string {
  return `You are an expert AI agent auditor. Your job is to extract every testable behavioral policy from the following system prompt.

A "policy" is any rule, constraint, instruction, or expectation that the agent is supposed to follow. Be EXHAUSTIVE — extract every single one, including implicit expectations about tone, formatting, escalation, safety, knowledge boundaries, and routing logic.

SYSTEM PROMPT TO ANALYZE:
<system_prompt>
${systemPrompt}
</system_prompt>

For each policy, provide:
- id: a short kebab-case slug (e.g., "escalate-billing-disputes")
- name: human-readable name (e.g., "Escalate billing disputes to human agent")
- description: what the policy requires — specific enough to test against a conversation
- complexity: 1-5 (1 = simple check like greeting, 5 = complex multi-turn behavior)
- category: one of "routing", "tone", "safety", "knowledge", "behavior", "formatting"

EXAMPLES:

If the system prompt says "Always greet the user by name if available", extract:
{"id": "greet-by-name", "name": "Greet user by name", "description": "When the user's name is available, the agent must use it in the greeting.", "complexity": 1, "category": "tone"}

If the system prompt says "For billing disputes over $100, escalate to a human agent", extract:
{"id": "escalate-high-value-billing", "name": "Escalate high-value billing disputes", "description": "When a user disputes a charge over $100, the agent must escalate to a human agent rather than resolving independently.", "complexity": 3, "category": "routing"}

If the system prompt says "Never make promises about pricing or availability that aren't in the product catalog", extract:
{"id": "no-fabricated-pricing", "name": "No fabricated pricing or availability claims", "description": "The agent must not make claims about pricing, discounts, or availability that are not explicitly stated in the system prompt or product catalog.", "complexity": 4, "category": "safety"}

Return ONLY a JSON array of policy objects. No additional text, markdown, or code blocks.

[
  {"id": "...", "name": "...", "description": "...", "complexity": 1, "category": "..."},
  ...
]`;
}

/**
 * Prompt 2: Conversation Evaluation (12 metrics)
 * Input: system prompt + conversation
 * Output: JSON with metric scores
 */
export function buildEvaluationPrompt(
  systemPrompt: string,
  conversation: string,
): string {
  return `You are an expert AI quality evaluator. Score this conversation across 12 quality metrics.

SYSTEM PROMPT (this is the ground truth for hallucination checking):
<system_prompt>
${systemPrompt}
</system_prompt>

CONVERSATION:
<conversation>
${conversation}
</conversation>

Score each metric 0-100. Use the FULL range — be precise and diverse in scoring. Not everything is 78.

METRIC DEFINITIONS:
- successScore: How well the AI achieved conversation goals (0=failed, 100=perfect)
- aiRelevancy: How relevant and on-topic responses were (0=off-topic, 100=perfectly relevant)
- sentiment: Estimated user satisfaction (0=frustrated, 100=delighted)
- hallucinationScore: CRITICAL — Score 0 if the AI makes claims about products, pricing, features, timelines, or capabilities NOT stated in the system prompt. Score 100 only if ALL claims are either explicitly in the system prompt or general knowledge. Making up specific numbers, prices, or policies is a severe hallucination.
- repetitionScore: Response variety (0=highly repetitive, 100=no repetition)
- consistencyScore: Coherence across turns (0=contradictory, 100=perfectly consistent)
- naturalLanguageScore: Language quality (0=poor, 100=excellent)
- contextRetentionScore: Context maintenance across turns (0=loses context, 100=perfect retention)
- verbosityScore: Response length appropriateness (0=way too brief or verbose, 100=just right)
- taskCompletion: Task achievement (0=failed, 100=perfectly completed)
- clarity: Response clarity and understandability (0=unclear, 100=crystal clear)
- truncationScore: BINARY ONLY — 0 means response was NOT truncated, 100 means truncation detected. No other values.

Return ONLY valid JSON with no additional text:
{
  "metrics": {
    "successScore": <0-100>,
    "aiRelevancy": <0-100>,
    "sentiment": <0-100>,
    "hallucinationScore": <0-100>,
    "repetitionScore": <0-100>,
    "consistencyScore": <0-100>,
    "naturalLanguageScore": <0-100>,
    "contextRetentionScore": <0-100>,
    "verbosityScore": <0-100>,
    "taskCompletion": <0-100>,
    "clarity": <0-100>,
    "truncationScore": <0 or 100>
  }
}`;
}

/**
 * Prompt 3: Policy Checker + Failure Classifier
 * Input: system prompt + conversation + policies (batched)
 * Output: per-policy pass/fail with evidence and failure classification
 */
export function buildPolicyCheckerPrompt(
  systemPrompt: string,
  conversation: string,
  policies: Policy[],
): string {
  const policyList = policies
    .map((p) => `- ${p.id}: "${p.name}" — ${p.description}`)
    .join("\n");

  return `You are an expert AI policy compliance auditor. Check this conversation against each policy and classify any failures.

SYSTEM PROMPT:
<system_prompt>
${systemPrompt}
</system_prompt>

CONVERSATION:
<conversation>
${conversation}
</conversation>

POLICIES TO CHECK:
${policyList}

For each policy, determine:
1. passed: true/false — did the agent comply with this policy?
2. evidence: quote the specific turn(s) that prove compliance or violation
3. failingTurns: array of turn numbers (1-based) where the violation occurred (empty if passed)
4. failureType: root cause category (only if failed):
   - "prompt_issue" — the prompt is missing instructions or has conflicting rules
   - "orchestration_issue" — routing, handoff, or multi-step flow failures
   - "model_limitation" — the model can't do what's asked regardless of prompt
   - "retrieval_rag_issue" — knowledge retrieval failures
5. failureSubtype: specific sub-category (only if failed):
   For prompt_issue: "context_loss", "intent_misclassification", "hallucination", "missing_escalation", "tone_violation"
   For orchestration_issue: "wrong_routing", "missing_handoff", "loop_detected"
   For model_limitation: "hallucination", "long_context_degradation", "instruction_following"
   For retrieval_rag_issue: "missing_tool_call", "wrong_retrieval", "stale_data"

Return ONLY a JSON array with no additional text:
[
  {
    "policyId": "policy-id",
    "passed": true,
    "evidence": "Turn 3: Agent correctly...",
    "failingTurns": [],
    "failureType": null,
    "failureSubtype": null
  },
  {
    "policyId": "another-policy",
    "passed": false,
    "evidence": "Turn 5: Agent fabricated a pricing policy...",
    "failingTurns": [5, 7],
    "failureType": "prompt_issue",
    "failureSubtype": "hallucination"
  }
]`;
}

/**
 * Prompt 4: Step-Level Diagnosis
 * Input: system prompt + conversation + policy results
 * Output: root cause analysis with cascade tracking and multi-agent attribution
 */
export function buildDiagnosisPrompt(
  systemPrompt: string,
  conversation: string,
  policyResults: Array<{ policyId: string; passed: boolean; evidence: string; failingTurns?: number[] }>,
): string {
  const failures = policyResults
    .filter((r) => !r.passed)
    .map(
      (r) =>
        `- ${r.policyId}: ${r.evidence} (turns: ${r.failingTurns?.join(", ") ?? "unknown"})`,
    )
    .join("\n");

  return `You are an expert AI agent diagnostician. Analyze this failed conversation to identify the root cause, trace its cascade effects, and attribute responsibility.

SYSTEM PROMPT:
<system_prompt>
${systemPrompt}
</system_prompt>

CONVERSATION:
<conversation>
${conversation}
</conversation>

POLICY FAILURES DETECTED:
${failures}

Provide a detailed diagnosis:

1. rootCauseTurn: the turn number where the failure ORIGINATED (not where it was first noticed — trace back to the actual cause)
2. rootCauseAgent: if multiple agents/roles are involved, which one caused the failure (e.g., "router", "faq-handler", "billing-agent"). Use null if single-agent.
3. summary: 1-2 crisp sentences identifying exactly what went wrong
4. impact: name affected turns and quote user reactions. Trace the CASCADE — how did the initial failure affect subsequent turns?
5. cascadeChain: array describing how the failure propagated turn by turn (e.g., ["Turn 4: fabricated policy", "Turn 5: user pushback ignored", "Turn 6: doubled down on fabrication"])
6. fix: a SPECIFIC prompt change suggestion (not vague — e.g., "Add before the FAQ handler section: 'If the user mentions billing dispute, charge dispute, or overcharge, immediately escalate to human agent. Do not attempt to resolve.'")
7. severity: "critical" (user harm, legal risk, trust broken), "major" (goal failed, user frustrated), "minor" (suboptimal but not harmful)
8. confidence: "high" (clear evidence), "medium" (probable), "low" (uncertain)
9. failureType: "prompt_issue" | "orchestration_issue" | "model_limitation" | "retrieval_rag_issue"
10. failureSubtype: specific sub-category
11. blastRadius: array of policy names that might be affected if the suggested fix is applied (policies that could regress)

Return ONLY valid JSON with no additional text:
{
  "rootCauseTurn": <number>,
  "rootCauseAgent": "<agent-name or null>",
  "summary": "...",
  "impact": "...",
  "cascadeChain": ["Turn N: ...", "Turn M: ..."],
  "fix": "...",
  "severity": "critical|major|minor",
  "confidence": "high|medium|low",
  "failureType": "...",
  "failureSubtype": "...",
  "blastRadius": ["policy-name-1", "policy-name-2"]
}`;
}

/**
 * Prompt 5: Fix Generator
 * Input: policy + example failing conversations + failure patterns
 * Output: directional fix text
 */
export function buildFixGeneratorPrompt(
  policy: Policy,
  failingExamples: string[],
  failurePatterns: string,
): string {
  const examples = failingExamples
    .map((ex, i) => `Example ${i + 1}:\n${ex}`)
    .join("\n\n");

  return `You are an expert prompt engineer. Generate a directional fix for this failing policy.

FAILING POLICY:
- Name: ${policy.name}
- Description: ${policy.description}
- Category: ${policy.category}

EXAMPLE FAILING CONVERSATIONS (worst 3):
${examples}

FAILURE PATTERN CONTEXT:
${failurePatterns}

Write a 2-4 sentence directional fix explaining what to change in the system prompt. Be specific about WHERE in the prompt to add/change instructions and WHAT the instruction should accomplish. Include a blast-radius warning about which other policies might be affected.

Return ONLY valid JSON:
{
  "fix": "Your directional fix text here. Be specific about the change.",
  "blastRadius": ["policy-name that might regress", "another-policy"]
}`;
}

/**
 * Prompt 6: Top Recommendations Generator
 * Input: all failure patterns + policy results
 * Output: top 3 actionable recommendations
 */
export function buildRecommendationsPrompt(
  failurePatterns: string,
  policySummary: string,
): string {
  return `You are an expert AI agent consultant. Based on these failure patterns and policy results, generate the top 3 most impactful recommendations.

FAILURE PATTERNS:
${failurePatterns}

POLICY COMPLIANCE SUMMARY:
${policySummary}

Each recommendation should be:
1. A specific, actionable prompt change (not vague advice)
2. Targeted at the highest-impact failure pattern
3. Include which failure types and subtypes it addresses
4. Include how many conversations would be affected
5. Include confidence level

Return ONLY valid JSON:
{
  "recommendations": [
    {
      "title": "Short action title (e.g., 'Add billing-dispute escalation rule')",
      "description": "2-3 sentences explaining the change, why it matters, and how to implement it.",
      "targetFailureTypes": ["prompt_issue"],
      "targetSubtypes": ["missing_escalation", "wrong_routing"],
      "affectedConversations": <number>,
      "confidence": "high|medium|low"
    }
  ]
}`;
}
