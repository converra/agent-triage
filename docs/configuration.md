# Configuration

## Config File

Create `agent-triage.config.yaml` for persistent settings:

```yaml
llm:
  provider: anthropic        # openai | anthropic | openai-compatible
  model: claude-sonnet-4-6   # any model supported by the provider
  # apiKey: ${ANTHROPIC_API_KEY}  # resolved from env vars
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

## Environment Variables

Set your API key as an environment variable or in a `.env` file (auto-loaded):

```bash
# LLM provider (one required)
export ANTHROPIC_API_KEY=sk-ant-...   # default provider
export OPENAI_API_KEY=sk-...

# Trace sources (optional — only needed for their respective connectors)
export LANGSMITH_API_KEY=lsv2_...
export AXIOM_API_KEY=xaat-...
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
# export LANGFUSE_HOST=https://cloud.langfuse.com  # for self-hosted
```

## Trace Formats

agent-triage accepts traces in five formats:

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

> **Note:** LangSmith's API is rate-limited, so fetching large projects can take a few minutes. agent-triage throttles requests automatically and shows progress. Use `--since` / `--until` to narrow the time window, or `--max-conversations` to cap the number of traces fetched.

### OpenTelemetry

Export OTLP/JSON traces from any OpenTelemetry-instrumented agent. agent-triage follows the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (pinned to v1.36.0).

### Langfuse

Reads traces from [Langfuse](https://langfuse.com) (cloud or self-hosted). Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`, optionally `LANGFUSE_HOST` for self-hosted instances.

### Axiom

Reads traces from [Axiom](https://axiom.co) datasets. Set `AXIOM_API_KEY` and pass the dataset name with `--axiom <dataset>`.

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

const llm = createLlmClient("anthropic", process.env.ANTHROPIC_API_KEY!, "claude-sonnet-4-6");
const conversations = await readJsonTraces("./conversations.json");
// ... evaluate, aggregate, generate report
```

See [src/index.ts](https://github.com/converra/agent-triage/blob/main/src/index.ts) for all available exports.

---

See also: [CLI Commands](commands.md) | [Debugging Workflow & Report Details](debugging-workflow.md)
