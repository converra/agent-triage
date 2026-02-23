[![CI](https://github.com/converra/converra-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/converra/converra-triage/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/converra-triage.svg)](https://www.npmjs.com/package/converra-triage)
[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg)](./LICENSE)

# converra-triage

**ESLint for AI agents.** Extract testable policies from your agent's prompt, evaluate production conversations against them, and generate a diagnostic HTML report — in under 3 minutes.

## Why?

Your agent's system prompt defines dozens of behavioral rules — but you have no way to know which ones are actually being followed in production. converra-triage extracts those rules as testable policies, evaluates real conversations against every one of them, and tells you exactly what's failing, why, and what to fix.

## Quick Start

See it in action (requires an LLM API key):

```bash
npx converra-triage demo
```

Use it on your own agent:

```bash
# 1. Extract policies from your agent's system prompt
npx converra-triage init --prompt system-prompt.txt

# 2. Evaluate conversations (from JSON, LangSmith, or OpenTelemetry)
npx converra-triage analyze --traces conversations.json --prompt system-prompt.txt

# 3. Open the report in your browser
npx converra-triage view
```

## Installation

```bash
# Run directly (no install needed)
npx converra-triage demo

# Or install as a project dependency
npm install converra-triage
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

## What It Does

`converra-triage` evaluates real conversations against behavioral policies **extracted from your system prompt** and generates a **single, self-contained HTML diagnostic report**. It tells you what failed, where it started — **down to the exact conversation turn** — why it happened, what to change, and what that change might break.

The report is designed for fast triage first, then deep forensics when you need it:

#### 1. Verdict & Metrics

Get an at-a-glance pipeline summary (e.g., `15 policies extracted → 8 conversations evaluated → 10 failures found`) and a clear verdict (e.g., `"6 of 15 policies are failing"`). A metrics dashboard tracks 12 quality scores (Success, Relevancy, Hallucination, Sentiment, Context Retention, etc.) alongside policy compliance so you can spot regressions and trends quickly.

#### 2. Patterns, Top Offenders, and Recommended Fixes

See **where things break at scale**: failures grouped by type and subtype (e.g., `Tone Violation`, `Missing Escalation`, `Hallucination`) and attributed to root-cause categories (prompt issues, orchestration, model limitations, RAG failures). The report highlights the **most affected conversations** with summaries and severity badges, and provides a **ranked list of concrete recommendations** — each with a confidence level and the number of conversations impacted — so you can ship the highest-leverage change first.

#### 3. Step-by-Step Deep Dive

For the most severe failure, the report drills all the way down:

- **Exact root-cause turn:** a color-coded timeline that marks where the failure begins and tags the violated policies directly on the offending turns (e.g., `"No fabricated pricing ✕"`, `"Escalate billing ✕"`).
- **Failure cascade:** how the initial mistake propagates into downstream issues across later turns — from fabrication to user pushback to the agent doubling down.
- **What happened / Impact / Fix:** a structured narrative with turn references and a concrete recommended change with confidence score.
- **Blast-radius preview:** which other policies are likely to shift if you apply the fix, with estimated impact percentages — so you don't trade one problem for another.

Every failing conversation gets its own expandable diagnosis card with the same structure. Every report includes the exact CLI command used to generate it for reproducibility.

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

### `init`

Extract testable policies from your agent's system prompt.

```bash
npx converra-triage init --prompt system-prompt.txt
```

Outputs `policies.json` — an editable file of behavioral rules your agent should follow. Review and adjust before running evaluation.

### `analyze`

Evaluate conversations against policies and generate a diagnostic report.

```bash
# From a JSON file
npx converra-triage analyze --traces conversations.json --prompt system-prompt.txt

# From LangSmith
npx converra-triage analyze --langsmith my-project --api-key $LANGSMITH_API_KEY

# From OpenTelemetry export
npx converra-triage analyze --otel traces.json
```

Options:
- `--dry-run` — show estimated cost without calling the LLM
- `--max-conversations <n>` — limit evaluation to N conversations
- `--model <model>` — use a specific model (default: gpt-4o-mini)
- `--provider <provider>` — openai, anthropic, or openai-compatible
- `--include-prompt` — include the system prompt text in the report JSON
- `--summary-only` — omit conversation transcripts from report

### `view`

Open the generated HTML report in your default browser.

```bash
npx converra-triage view
```

### `diff`

Compare two reports to see what changed after prompt edits.

```bash
npx converra-triage diff before/report.json after/report.json
```

### `demo`

Run a full demo with built-in example agents and traces.

```bash
npx converra-triage demo                    # customer-support (default)
npx converra-triage demo customer-support
```

## Trace Format

converra-triage accepts conversations in three formats:

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

Point to a LangSmith project and converra-triage will fetch traces automatically. Requires `LANGSMITH_API_KEY`.

### OpenTelemetry

Export OTLP/JSON traces from any OpenTelemetry-instrumented agent. converra-triage follows the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (pinned to v1.36.0).

## Configuration

Create `converra-triage.config.yaml` for persistent settings:

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

converra-triage can be used as a library:

```typescript
import {
  readJsonTraces,
  extractPolicies,
  createLlmClient,
  evaluateAll,
  buildHtml,
} from "converra-triage";

const llm = createLlmClient("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
const conversations = await readJsonTraces("./conversations.json");
// ... evaluate, aggregate, generate report
```

See [src/index.ts](src/index.ts) for all available exports.

## How It Compares

| Feature | converra-triage | IntellAgent | DeepEval | Promptfoo |
|---------|:-:|:-:|:-:|:-:|
| Production trace analysis | Yes | No | Partial | Partial |
| Policy extraction from prompts | Yes | No | No | No |
| Multi-connector (JSON, LangSmith, OTel) | Yes | LangGraph only | Custom | Custom |
| Quality metrics (12 built-in) | Yes | Binary pass/fail | Custom | Custom |
| Self-contained HTML report | Yes | No | Dashboard | No |
| Step-level root cause + cascade | Yes | No | No | No |
| Blast-radius warnings | Yes | No | No | No |
| Cross-run diff | Yes | No | No | Yes |
| No infrastructure required | Yes | Yes | No (server) | Yes |
| License | FSL-1.1 | MIT | Apache 2.0 | MIT |

> Comparison accurate as of February 2026. [Open an issue](https://github.com/converra/converra-triage/issues) if any entry needs updating.

## converra-triage vs. Converra

converra-triage is a standalone diagnostic tool. It gives you a complete picture of what's failing and why.

[Converra](https://converra.ai) is an optional next step that automates the fix cycle:

- **Tested fix proposals** — concrete prompt patches with confidence scores, not directional hints
- **Simulation testing** — test fixes against personas, scenarios, and complexity levels before deploying
- **Regression gating** — ensure fixes don't break other policies
- **Continuous optimization** — automatic prompt improvement based on production performance

## License

[FSL-1.1-Apache-2.0](./LICENSE) — Free to use and self-host. Cannot be offered as a competing hosted service. Converts to Apache 2.0 after 2 years.

## Contributing

We welcome contributions, especially new trace connectors. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

```bash
git clone https://github.com/converra/converra-triage
cd converra-triage
npm install
npm run build
npm test          # 151 tests
```

---

Built by [Converra](https://converra.ai)
