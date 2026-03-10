# The Debugging Workflow

agent-triage is built around a debugging funnel — start cheap and broad, narrow to expensive and deep:

```
SIGNAL → SCOPE → ISOLATE → DIAGNOSE → FIX → VERIFY
```

Here's what that looks like in practice:

```bash
# 1. Signal: is something wrong? (instant, reads from disk)
agent-triage status

# 2. Scope: what kind of conversations are failing? (~60% cheaper than full analyze)
agent-triage analyze --langsmith my-project --since 24h --quick

# 3. Isolate: find the worst failure
agent-triage explain --worst

# 4. Diagnose: deep-dive into a specific conversation
agent-triage explain conv_abc123

# 5. Fix the prompt, then verify
agent-triage analyze --langsmith my-project
agent-triage diff before/report.json after/report.json

# 6. Track progress over time
agent-triage history
```

Every command in this flow builds on the previous one. `status` tells you if there's a problem. `explain --worst` tells you what the problem is. `diff` tells you if your fix worked.

See the [full command reference](commands.md) for all options on each command.

## What the Report Contains

agent-triage evaluates production agent traces against behavioral policies extracted from your system prompt and generates a single, self-contained HTML diagnostic report. It shows what failed, where it started — down to the exact step and the responsible agent — why it happened, what to change, and what that change might break.

The report is designed for fast triage first, then deep forensics when you need it:

### 1. Verdict & Metrics

An at-a-glance pipeline summary (e.g., `15 policies extracted → 8 traces evaluated → 10 failures found`) and a clear verdict (e.g., `"6 of 15 policies are failing"`). A metrics dashboard tracks 12 quality scores alongside policy compliance so you can spot regressions and trends quickly.

### 2. Patterns, Top Offenders, and Recommended Fixes

Failures grouped by type and subtype (e.g., `Hallucination`, `Missing Handoff`, `Wrong Routing`, `Tone Violation`) and attributed to root-cause categories — prompt issues, orchestration failures, model limitations, or RAG gaps. The report highlights the most affected traces with summaries and severity badges, and provides a ranked list of concrete recommendations — each with a confidence level and the number of conversations impacted.

### 3. Step-by-Step Deep Dive

For the most severe failure, the report drills all the way down:

- **Exact root-cause step:** a color-coded timeline that marks where the failure begins, tags the violated policies on the offending steps, and attributes the failure to the responsible agent in multi-agent setups.
- **Failure cascade:** how the initial mistake propagates — from hallucination to user pushback to a missed handoff to the agent doubling down.
- **What happened / Impact / Fix:** a structured narrative with step references and a concrete recommended change with confidence score.
- **Blast-radius preview:** which other policies are likely to shift if you apply the fix, with estimated impact percentages.

Every failing trace gets its own expandable diagnosis card with the same structure. Every report includes the exact CLI command used to generate it for reproducibility.

## 12 Quality Metrics

In addition to policy compliance, the report evaluates each conversation on 12 quality metrics:

| Metric | What It Measures |
|--------|-----------------|
| Success Score | Did the agent achieve the user's goal? |
| AI Relevancy | Were responses on-topic and useful? |
| Sentiment | How did the user feel during the conversation? |
| Hallucination | Did the agent make claims not in the system prompt? |
| Repetition | Did the agent repeat itself unnecessarily? |
| Consistency | Were responses consistent with each other? |
| Natural Language | Did the agent sound natural and human? |
| Context Retention | Did the agent remember earlier context? |
| Verbosity | Were responses appropriately concise? |
| Task Completion | Were all user requests addressed? |
| Clarity | Were responses clear and easy to understand? |
| Truncation | Were responses cut off mid-sentence? |

See [configuration](configuration.md) for config file and environment variable reference.
