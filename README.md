# converra-triage

**eslint for AI agents.** Extract testable policies from your agent's prompt, evaluate production conversations against them, and generate a diagnostic HTML report — in under 3 minutes.

```
npx converra-triage demo
```

## Quick Start

```bash
# 1. Extract policies from your agent's system prompt
npx converra-triage init --prompt system-prompt.txt

# 2. Evaluate conversations against those policies
npx converra-triage analyze --traces conversations.json --prompt system-prompt.txt

# 3. Open the report in your browser
npx converra-triage view
```

## What It Does

converra-triage reads your agent's production conversations, scores them across 12 quality metrics, checks every conversation against behavioral policies extracted from your prompt, and generates a self-contained HTML report showing:

- **Which policies are failing** — with compliance rates and trends
- **Why they're failing** — 4 root cause categories (prompt issues, orchestration, model limitations, RAG failures)
- **Directional fixes** — what to change in your prompt or config
- **Blast-radius warnings** — which other policies might break if you edit
- **Deep-dive diagnosis** — step-level attribution with cascade analysis for the worst failures

### 12 Quality Metrics

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

### LangSmith

Point to a LangSmith project and converra-triage will fetch traces automatically.

### OpenTelemetry

Export OTLP/JSON traces from any OpenTelemetry-instrumented agent. converra-triage follows the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

## Configuration

Create `converra-triage.config.yaml` for persistent settings:

```yaml
llm:
  provider: openai
  model: gpt-4o-mini
  # apiKey: ${OPENAI_API_KEY}  # or set env var

agent:
  name: "My Support Agent"
```

Or pass everything via CLI flags and environment variables.

## How It Compares

| Feature | converra-triage | IntellAgent | DeepEval | Promptfoo |
|---------|:-:|:-:|:-:|:-:|
| Production trace analysis | Yes | No | Partial | No |
| Policy extraction from prompts | Yes | No | No | No |
| Multi-connector (JSON, LangSmith, OTel) | Yes | LangGraph only | Custom | Custom |
| 12 quality metrics | Yes | Binary pass/fail | 6 metrics | Custom |
| Self-contained HTML report | Yes | No | Dashboard | No |
| Step-level diagnosis | Yes | No | No | No |
| Blast-radius warnings | Yes | No | No | No |
| Cross-run diff | Yes | No | No | Yes |
| Free & open source | FSL | MIT | Apache 2.0 | MIT |
| No infrastructure required | Yes | Yes | No (server) | Yes |

## What converra-triage diagnoses vs. what Converra treats

converra-triage finds the problems. [Converra](https://converra.ai) fixes them:

- **Tested fix proposals** — not directional hints, but concrete prompt patches with confidence scores
- **Simulation testing** — test fixes against personas, scenarios, and complexity levels before deploying
- **Regression gating** — ensure fixes don't break other policies
- **Continuous optimization** — automatic prompt improvement based on production performance

## License

[FSL-1.1-Apache-2.0](./LICENSE) — Free to use and self-host. Cannot be offered as a competing hosted service. Converts to Apache 2.0 after 2 years.

## Contributing

We welcome contributions, especially new trace connectors. See the [NormalizedConversation interface](src/ingestion/types.ts) for the contract your connector needs to implement.

```bash
git clone https://github.com/converra/converra-triage
cd converra-triage
npm install
npm run build
npm test
```

---

Built by [Converra](https://converra.ai)
