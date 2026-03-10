# CLI Commands

## `analyze`

Evaluate traces against policies and generate a diagnostic report.

```bash
# From a JSON file
agent-triage analyze --traces conversations.json --prompt system-prompt.txt

# From LangSmith (zero-config — auto-discovers agents and policies)
agent-triage analyze --langsmith my-project

# From OpenTelemetry export
agent-triage analyze --otel traces.json

# From Langfuse
agent-triage analyze --langfuse

# From Axiom
agent-triage analyze --axiom my-dataset

# Quick mode: skip diagnosis/fixes, ~60% cheaper
agent-triage analyze --langsmith my-project --quick

# Filter by time and agent
agent-triage analyze --langsmith my-project --since 24h --agent "billing-agent"
```

Options:
- `--traces <path>` — path to JSON/JSONL trace file
- `--langsmith <project>` — LangSmith project name
- `--otel <path>` — OpenTelemetry OTLP/JSON export
- `--langfuse` — read from Langfuse (cloud or self-hosted)
- `--axiom <dataset>` — Axiom dataset name
- `--prompt <path>` — system prompt file for policy extraction
- `--quick` — skip diagnosis and fix generation (faster, ~60% cheaper)
- `--since <duration>` / `--until <duration>` — time window (e.g. `2h`, `24h`, `7d`)
- `--agent <name>` — filter to a specific agent
- `--dry-run` — show estimated cost without calling the LLM
- `--max-conversations <n>` — limit evaluation to N traces
- `--format json` — output JSON to stdout instead of terminal summary
- `--model <model>` — evaluator model (default: `claude-sonnet-4-6`)
- `--provider <provider>` — `openai`, `anthropic`, or `openai-compatible`
- `--include-prompt` — include the system prompt text in the report JSON
- `--summary-only` — omit trace transcripts from report

## `explain`

Deep-dive diagnosis of a single conversation — root cause, cascade chain, blast radius, and suggested fix.

```bash
# Explain the worst failing conversation from the last report
agent-triage explain --worst

# Explain a specific conversation
agent-triage explain conv_abc123

# Explain from a trace source (if no report exists yet)
agent-triage explain conv_abc123 --langsmith my-project
```

## `check`

Targeted policy compliance check — faster and cheaper than full analyze (no metrics, no diagnosis).

```bash
# Check all policies
agent-triage check --langsmith my-project --since 24h

# Check specific policies
agent-triage check --langsmith my-project --policy escalation-policy --policy tone-policy

# CI gate: exit code 1 if compliance below threshold
agent-triage check --traces conversations.json --threshold 90
```

## `status`

Instant health check from the last report. Zero LLM cost — reads from disk.

```bash
agent-triage status
```

## `history`

Show compliance trends across analyze runs. Zero LLM cost.

```bash
# Show all runs
agent-triage history

# Show last 5 runs
agent-triage history --last 5

# JSON output
agent-triage history --format json
```

## `init`

Extract testable policies from your agent's system prompt.

```bash
agent-triage init --prompt system-prompt.txt
```

Outputs `policies.json` — an editable file of behavioral rules your agent should follow. Review and adjust before running evaluation.

## `diff`

Compare two reports to see what changed after prompt edits.

```bash
agent-triage diff before/report.json after/report.json
```

## `view`

Open the generated HTML report in your default browser.

```bash
agent-triage view
```

## `demo`

Run a full demo with built-in example agents and traces.

```bash
agent-triage demo
```
