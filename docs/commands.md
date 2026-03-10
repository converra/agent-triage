# CLI Commands

All commands support `--help` for inline usage. See [configuration](configuration.md) for config file, environment variables, and trace format details.

## `analyze`

Evaluate traces against policies and generate a diagnostic report.

```bash
agent-triage analyze --traces conversations.json --prompt system-prompt.txt
agent-triage analyze --langsmith my-project
agent-triage analyze --otel traces.json
agent-triage analyze --langfuse
agent-triage analyze --axiom my-dataset
agent-triage analyze --langsmith my-project --quick --since 24h --agent "billing-agent"
```

Options:
- `--traces <path>` — path to JSON/JSONL trace file
- `--langsmith <project>` — LangSmith project name
- `--langsmith-api-key <key>` — LangSmith API key (or set `LANGSMITH_API_KEY`)
- `--otel <path>` — OpenTelemetry OTLP/JSON export
- `--langfuse` — read from Langfuse (cloud or self-hosted)
- `--langfuse-public-key <key>` — Langfuse public key (or set `LANGFUSE_PUBLIC_KEY`)
- `--langfuse-secret-key <key>` — Langfuse secret key (or set `LANGFUSE_SECRET_KEY`)
- `--langfuse-host <url>` — Langfuse host (default: `https://cloud.langfuse.com`)
- `--axiom <dataset>` — Axiom dataset name
- `--axiom-api-key <key>` — Axiom API key (or set `AXIOM_API_KEY`)
- `--axiom-org-id <id>` — Axiom org ID (for personal access tokens)
- `--policies <path>` — path to policies.json (default: `policies.json`)
- `-p, --prompt <path>` — system prompt file (for policy extraction and evaluation accuracy)
- `--quick` — skip diagnosis and fix generation (faster, ~60% cheaper)
- `--since <duration>` / `--until <duration>` — time window (e.g. `2h`, `24h`, `7d`)
- `--agent <name>` — filter to a specific agent
- `--dry-run` — show estimated cost without calling the LLM
- `--max-conversations <n>` — limit evaluation to N traces
- `--format json` — output JSON to stdout instead of terminal summary
- `--model <model>` — evaluator model (default: `claude-sonnet-4-6`)
- `--provider <provider>` — `openai`, `anthropic`, or `openai-compatible`
- `--api-key <key>` — LLM API key (or set env var)
- `--include-prompt` — include the system prompt text in the report JSON
- `--summary-only` — omit trace transcripts from report
- `-o, --output <dir>` — output directory (default: `.`)

## `explain`

Deep-dive diagnosis of a single conversation — root cause, cascade chain, blast radius, and suggested fix.

```bash
agent-triage explain --worst
agent-triage explain conv_abc123
agent-triage explain conv_abc123 --langsmith my-project
```

Options:
- `--worst` — explain the worst conversation from the last report
- `--traces <path>` — path to JSON traces file
- `--langsmith <project>` — LangSmith project name
- `--langsmith-api-key <key>` — LangSmith API key
- `--otel <path>` — OpenTelemetry export
- `--langfuse` — read from Langfuse
- `--langfuse-public-key <key>` / `--langfuse-secret-key <key>` / `--langfuse-host <url>`
- `--axiom <dataset>` — Axiom dataset
- `--axiom-api-key <key>` / `--axiom-org-id <id>`
- `--policies <path>` — path to policies.json (default: `policies.json`)
- `-p, --prompt <path>` — system prompt file
- `--provider <provider>` / `--model <model>` / `--api-key <key>` — LLM config
- `--since <duration>` — time filter for trace source
- `--agent <name>` — agent filter
- `--format <format>` — `terminal` (default) or `json`

## `check`

Targeted policy compliance check — faster and cheaper than full analyze (no metrics, no diagnosis).

```bash
agent-triage check --langsmith my-project --since 24h
agent-triage check --langsmith my-project --policy escalation-policy --policy tone-policy
agent-triage check --traces conversations.json --threshold 90  # CI gate
```

Options:
- `--traces <path>` — path to JSON traces file
- `--langsmith <project>` — LangSmith project name
- `--langsmith-api-key <key>` — LangSmith API key
- `--otel <path>` — OpenTelemetry export
- `--langfuse` — read from Langfuse
- `--langfuse-public-key <key>` / `--langfuse-secret-key <key>` / `--langfuse-host <url>`
- `--axiom <dataset>` — Axiom dataset
- `--axiom-api-key <key>` / `--axiom-org-id <id>`
- `--policies <path>` — path to policies.json (default: `policies.json`)
- `--policy <id>` — check specific policy (repeatable)
- `-p, --prompt <path>` — system prompt file
- `--provider <provider>` / `--model <model>` / `--api-key <key>` — LLM config
- `--since <duration>` / `--until <duration>` — time window
- `--agent <name>` — filter to a specific agent
- `--max-conversations <n>` — limit traces to check
- `--threshold <n>` — exit with code 1 if compliance below this % (for CI)
- `--format <format>` — `terminal` (default) or `json`

## `init`

Extract testable policies from your agent's system prompt.

```bash
agent-triage init --prompt system-prompt.txt
agent-triage init --prompt system-prompt.txt -o my-policies.json
```

Options:
- `-p, --prompt <path>` — path to the system prompt file
- `-o, --output <path>` — output path for policies.json (default: `policies.json`)
- `--provider <provider>` / `--model <model>` / `--api-key <key>` — LLM config

Outputs `policies.json` — an editable file of behavioral rules your agent should follow. Review and adjust before running evaluation.

## `status`

Instant health check from the last report. Zero LLM cost — reads from disk.

```bash
agent-triage status
agent-triage status -r ./my-project
```

Options:
- `-r, --report <dir>` — directory containing report.json (default: `.`)
- `--format <format>` — `terminal` (default) or `json`

## `history`

Show compliance trends across analyze runs. Zero LLM cost.

```bash
agent-triage history
agent-triage history --last 5
agent-triage history --format json
```

Options:
- `-r, --report <dir>` — directory containing `.triage-history.jsonl` (default: `.`)
- `--last <n>` — show only the last N runs
- `--format <format>` — `terminal` (default) or `json`

## `diff`

Compare two reports to see what changed after prompt edits.

```bash
agent-triage diff before/report.json after/report.json
agent-triage diff before/report.json after/report.json -o ./results
```

Arguments:
- `<before>` — path to the before report.json
- `<after>` — path to the after report.json

Options:
- `-o, --output <dir>` — output directory for diff.json (default: `.`)

## `view`

Open the generated HTML report in your default browser.

```bash
agent-triage view
agent-triage view -r ./my-project
```

Options:
- `-r, --report <dir>` — directory containing report.html (default: `.`)

## `demo`

Run a full demo with built-in example agents and traces.

```bash
agent-triage demo
agent-triage demo customer-support
```

Options:
- `[example]` — optional example name (e.g., `customer-support`)
- `--provider <provider>` / `--model <model>` / `--api-key <key>` — LLM config
