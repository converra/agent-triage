[![CI](https://github.com/converra/agent-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/converra/agent-triage/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agent-triage.svg)](https://www.npmjs.com/package/agent-triage)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

# agent-triage

**Diagnose your AI agents in production.** Extract testable policies from your agent's system prompt, evaluate real traces against them, and generate a diagnostic report that pinpoints exactly what's failing, which agent caused it, and what to fix — in minutes, not days.

## Why?

Your agent's system prompt is a behavioral contract — dozens of rules about tone, routing, safety, escalation, and knowledge boundaries. But once agents are live, you're flying blind. Which rules are actually being followed? Where do handoffs break? When does the agent hallucinate instead of escalating?

agent-triage turns that contract into testable policies, audits production traces against every one of them, and shows you exactly where things go wrong — down to the specific step, the specific agent, and the specific policy that was violated.

## Quick Start

See it in action (requires an LLM API key):

```bash
npx agent-triage demo
```

Use it on your own agent:

```bash
# 1. Extract policies from your agent's system prompt
npx agent-triage init --prompt system-prompt.txt

# 2. Evaluate traces (from JSON, LangSmith, or OpenTelemetry)
npx agent-triage analyze --traces conversations.json --prompt system-prompt.txt

# 3. Open the report in your browser
npx agent-triage view
```

Or skip the setup entirely — agent-triage can auto-discover agents and extract policies directly from LangSmith traces:

```bash
# Zero-config: auto-discovers agents, extracts policies, evaluates everything
npx agent-triage analyze --langsmith my-project
```

## Installation

```bash
# Run directly (no install needed)
npx agent-triage demo

# Or install as a project dependency
npm install agent-triage
```

## Requirements

- **Node.js** >= 18
- An **LLM API key** — [OpenAI](https://platform.openai.com/api-keys) (default) or [Anthropic](https://console.anthropic.com/)

Set your API key as an environment variable:

```bash
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

## The Debugging Workflow

agent-triage is built around a debugging funnel — start cheap and broad, narrow to expensive and deep:

```
SIGNAL → SCOPE → ISOLATE → DIAGNOSE → FIX → VERIFY
```

Here's what that looks like in practice:

```bash
# 1. Signal: is something wrong? (instant, reads from disk)
agent-triage status

# 2. Scope: what kind of conversations are failing? (zero LLM cost)
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

## What It Does

`agent-triage` evaluates production agent traces against behavioral policies **extracted from your system prompt** and generates a **single, self-contained HTML diagnostic report**. It tells you what failed, where it started — **down to the exact step and the responsible agent** — why it happened, what to change, and what that change might break.

The report is designed for fast triage first, then deep forensics when you need it:

#### 1. Verdict & Metrics

Get an at-a-glance pipeline summary (e.g., `15 policies extracted → 8 traces evaluated → 10 failures found`) and a clear verdict (e.g., `"6 of 15 policies are failing"`). A metrics dashboard tracks 12 quality scores (Success, Relevancy, Hallucination, Sentiment, Context Retention, etc.) alongside policy compliance so you can spot regressions and trends quickly.

#### 2. Patterns, Top Offenders, and Recommended Fixes

See **where things break at scale**: failures grouped by type and subtype (e.g., `Hallucination`, `Missing Handoff`, `Wrong Routing`, `Tone Violation`) and attributed to root-cause categories — prompt issues, orchestration failures, model limitations, or RAG gaps. The report highlights the **most affected traces** with summaries and severity badges, and provides a **ranked list of concrete recommendations** — each with a confidence level and the number of conversations impacted — so you can ship the highest-leverage change first.

#### 3. Step-by-Step Deep Dive

For the most severe failure, the report drills all the way down:

- **Exact root-cause step:** a color-coded timeline that marks where the failure begins, tags the violated policies directly on the offending steps (e.g., `"No fabricated pricing ✕"`, `"Escalate billing ✕"`), and attributes the failure to the responsible agent in multi-agent setups.
- **Failure cascade:** how the initial mistake propagates — from hallucination to user pushback to a missed handoff to the agent doubling down.
- **What happened / Impact / Fix:** a structured narrative with step references and a concrete recommended change with confidence score.
- **Blast-radius preview:** which other policies are likely to shift if you apply the fix, with estimated impact percentages — so you don't trade one problem for another.

Every failing trace gets its own expandable diagnosis card with the same structure. Every report includes the exact CLI command used to generate it for reproducibility.

<details>
<summary><strong>12 Quality Metrics</strong></summary>

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

</details>

## Commands

### `analyze`

Evaluate traces against policies and generate a diagnostic report.

```bash
# From a JSON file
agent-triage analyze --traces conversations.json --prompt system-prompt.txt

# From LangSmith (zero-config — auto-discovers agents and policies)
agent-triage analyze --langsmith my-project

# From OpenTelemetry export
agent-triage analyze --otel traces.json

# Quick mode: skip diagnosis/fixes, ~60% cheaper
agent-triage analyze --langsmith my-project --quick

# Filter by time and agent
agent-triage analyze --langsmith my-project --since 24h --agent "billing-agent"
```

Options:
- `--quick` — skip diagnosis and fix generation (faster, ~60% cheaper)
- `--since <duration>` / `--until <duration>` — time window (e.g. `2h`, `24h`, `7d`)
- `--agent <name>` — filter to a specific agent
- `--dry-run` — show estimated cost without calling the LLM
- `--max-conversations <n>` — limit evaluation to N traces
- `--format json` — output JSON to stdout instead of terminal summary
- `--model <model>` — use a specific model (default: gpt-4o-mini)
- `--provider <provider>` — openai, anthropic, or openai-compatible
- `--include-prompt` — include the system prompt text in the report JSON
- `--summary-only` — omit trace transcripts from report

### `explain`

Deep-dive diagnosis of a single conversation — root cause, cascade chain, blast radius, and suggested fix.

```bash
# Explain the worst failing conversation from the last report
agent-triage explain --worst

# Explain a specific conversation
agent-triage explain conv_abc123

# Explain from a trace source (if no report exists yet)
agent-triage explain conv_abc123 --langsmith my-project
```

### `check`

Targeted policy compliance check — faster and cheaper than full analyze (no metrics, no diagnosis).

```bash
# Check all policies
agent-triage check --langsmith my-project --since 24h

# Check specific policies
agent-triage check --langsmith my-project --policy escalation-policy --policy tone-policy

# CI gate: exit code 1 if compliance below threshold
agent-triage check --traces conversations.json --threshold 90
```

### `status`

Instant health check from the last report. Zero LLM cost — reads from disk.

```bash
agent-triage status
```

### `history`

Show compliance trends across analyze runs. Zero LLM cost.

```bash
# Show all runs
agent-triage history

# Show last 5 runs
agent-triage history --last 5

# JSON output
agent-triage history --format json
```

### `init`

Extract testable policies from your agent's system prompt.

```bash
agent-triage init --prompt system-prompt.txt
```

Outputs `policies.json` — an editable file of behavioral rules your agent should follow. Review and adjust before running evaluation.

### `diff`

Compare two reports to see what changed after prompt edits.

```bash
agent-triage diff before/report.json after/report.json
```

### `view`

Open the generated HTML report in your default browser.

```bash
agent-triage view
```

### `demo`

Run a full demo with built-in example agents and traces.

```bash
agent-triage demo
```

## MCP Server

agent-triage includes an MCP (Model Context Protocol) server, so AI assistants like Claude and Cursor can debug your agents programmatically.

```json
{
  "mcpServers": {
    "agent-triage": {
      "command": "npx",
      "args": ["-y", "agent-triage-mcp"]
    }
  }
}
```

The MCP server exposes 9 tools that follow the same debugging funnel:

| Tool | Cost | Purpose |
|------|------|---------|
| `triage_status` | Zero | Health check from last report |
| `triage_sample` | Zero | Browse conversations with keyword search |
| `triage_list_policies` | Zero | List loaded policies |
| `triage_history` | Zero | Compliance trends across runs |
| `triage_diff` | Zero | Compare two reports |
| `triage_check` | Moderate | Targeted policy compliance |
| `triage_explain` | Moderate | Root cause diagnosis |
| `triage_init` | Moderate | Extract policies from prompt |
| `triage_analyze` | High | Full evaluation pipeline |

An AI assistant using these tools would naturally: check `triage_status` to see if there's a problem, use `triage_sample` with keyword search to find relevant conversations, then `triage_explain` to diagnose the root cause.

## Trace Format

agent-triage accepts traces in three formats:

### JSON (recommended)

```json
[
  {
    "id": "conv_001",
    "messages": [
      { "role": "system", "content": "You are a support agent..." },
      { "role": "user", "content": "I need help with my order" },
      { "role": "assistant", "content": "I'd be happy to help!" }
    ]
  }
]
```

Flexible field mapping is supported — `role`/`sender`, `content`/`text`/`message`, `human`/`ai`/`bot`/`agent` role variants are all accepted. JSONL format (one conversation per line) also works.

### LangSmith

Point to a LangSmith project and agent-triage will fetch traces automatically. Auto-detects trace-based vs session-based architectures, discovers agents by system prompt, and pushes time filters server-side for efficiency. Requires `LANGSMITH_API_KEY`.

### OpenTelemetry

Export OTLP/JSON traces from any OpenTelemetry-instrumented agent. agent-triage follows the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (pinned to v1.36.0).

## Configuration

Create `agent-triage.config.yaml` for persistent settings:

```yaml
llm:
  provider: openai
  model: gpt-4o-mini
  # apiKey: ${OPENAI_API_KEY}  # resolved from env vars
  maxConcurrency: 5

prompt:
  path: system-prompt.txt

agent:
  name: "My Support Agent"

output:
  dir: .
  maxConversations: 500
```

Environment variable references (`${VAR_NAME}`) are automatically resolved in config values. CLI flags take precedence over config file values.

## Programmatic API

agent-triage can be used as a library:

```typescript
import {
  readJsonTraces,
  extractPolicies,
  createLlmClient,
  evaluateAll,
  buildHtml,
} from "agent-triage";

const llm = createLlmClient("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
const conversations = await readJsonTraces("./conversations.json");
// ... evaluate, aggregate, generate report
```

See [src/index.ts](src/index.ts) for all available exports.

## How It Compares

| Feature | agent-triage | IntellAgent | DeepEval | Promptfoo |
|---------|:-:|:-:|:-:|:-:|
| Production trace analysis | Yes | No | Partial | Partial |
| Policy extraction from prompts | Yes | No | No | No |
| Multi-connector (JSON, LangSmith, OTel) | Yes | LangGraph only | Custom | Custom |
| Quality metrics (12 built-in) | Yes | Binary pass/fail | Custom | Custom |
| Self-contained HTML report | Yes | No | Dashboard | No |
| Step-level root cause + cascade | Yes | No | No | No |
| Blast-radius warnings | Yes | No | No | No |
| Cross-run diff | Yes | No | No | Yes |
| MCP server for AI assistants | Yes | No | No | No |
| Zero-config LangSmith | Yes | No | No | No |
| CI compliance gates | Yes | No | Yes | Yes |
| No infrastructure required | Yes | Yes | No (server) | Yes |
| License | MIT | MIT | Apache 2.0 | MIT |

> Comparison accurate as of February 2026. [Open an issue](https://github.com/converra/agent-triage/issues) if any entry needs updating.

## agent-triage vs. Converra

agent-triage is a standalone diagnostic tool. It gives you a complete picture of what's failing and why.

[Converra](https://converra.ai) is an optional next step that automates the fix cycle:

- **Tested fix proposals** — concrete prompt patches with confidence scores, not directional hints
- **Simulation testing** — test fixes against personas, scenarios, and complexity levels before deploying
- **Regression gating** — ensure fixes don't break other policies
- **Continuous monitoring** — alerts and dashboards for agent health over time
- **Team collaboration** — shared workspace for reviewing and deploying fixes

## License

[MIT License](./LICENSE)

## Contributing

We welcome contributions, especially new trace connectors. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

```bash
git clone https://github.com/converra/agent-triage
cd agent-triage
npm install
npm run build
npm test
```

---

Built by [Converra](https://converra.ai)
