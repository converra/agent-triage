[![CI](https://github.com/converra/agent-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/converra/agent-triage/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agent-triage.svg)](https://www.npmjs.com/package/agent-triage)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

# agent-triage

**Diagnose your AI agents in production.** Extract testable policies from your agent's system prompt, evaluate real traces against them, and generate a diagnostic report showing what's failing, which agent caused it, and what to fix.

> Your agent's system prompt says "never fabricate pricing." Is it actually following that rule in production?

## Quick Start

```bash
# Try the demo (~3 minutes, see cost table below)
npx agent-triage demo

# Or use it on your own agent
npx agent-triage analyze --traces conversations.json --prompt system-prompt.txt

# Zero-config with LangSmith — auto-discovers agents and policies
npx agent-triage analyze --langsmith my-project
```

**Cost per 10 conversations** (use `--dry-run` to preview before running):

| Model | Provider | Cost | Flag |
|-------|----------|------|------|
| `gpt-4o-mini` | OpenAI | ~$0.02 | `--provider openai --model gpt-4o-mini` |
| `claude-haiku-4-5` | Anthropic | ~$0.08 | `--model claude-haiku-4-5-20251001` |
| `gpt-4o` | OpenAI | ~$0.40 | `--provider openai` |
| `claude-sonnet-4-6` | Anthropic | ~$0.90 | default |

**Privacy:** Traces stay on your machine. Only LLM API calls leave — no telemetry, nothing sent to us.

## How it works

```
System prompt → Extracted policies → Evaluate traces → Diagnostic report
```

For example, given a system prompt containing "Always confirm the user's issue before taking action", agent-triage extracts a testable policy, then checks every conversation for compliance:

```
Policy: "Confirm user's issue before acting"
conv_002 Turn 3: FAIL — agent said "I understand your concern" without
                  restating the specific issue ($150 charge vs $89 order)
```

## What you get

Root cause breakdown with failure categories, severity scores, and fix recommendations:

![agent-triage report showing failure categories, severity scores, and fix recommendations](assets/report-overview.png)

Step-by-step conversation replay showing exactly where things went wrong and which agent caused it:

![agent-triage step analysis showing conversation timeline with policy violations](assets/report-step-analysis.png)

See [Debugging Workflow](docs/debugging-workflow.md) for a detailed walkthrough of the report output and the diagnose-fix-verify loop.

## Installation

```bash
# Run directly (no install needed)
npx agent-triage demo

# Or install as a project dependency
npm install agent-triage
```

**Requirements:** Node.js >= 18 and an LLM API key — [Anthropic](https://console.anthropic.com/) (default) or [OpenAI](https://platform.openai.com/api-keys).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

A `.env` file in your project root is auto-loaded.

## Commands

| Command | What it does | LLM Cost |
|---------|-------------|----------|
| `analyze` | Evaluate traces against policies, generate report | ~$0.90/10 convos |
| `check` | Targeted policy compliance (no metrics/diagnosis) | Lower |
| `explain` | Deep-dive a single conversation | Moderate |
| `init` | Extract policies from a system prompt | Moderate |
| `status` | Health check from last report | Zero |
| `history` | Compliance trends across runs | Zero |
| `diff` | Compare two reports | Zero |
| `view` | Open HTML report in browser | Zero |
| `demo` | Run with built-in example data | ~$0.90 |

```bash
# Core workflow
agent-triage analyze --traces conversations.json --prompt system-prompt.txt
agent-triage analyze --langsmith my-project --since 24h --quick
agent-triage explain --worst
agent-triage check --traces data.json --threshold 90  # CI gate
agent-triage diff before/report.json after/report.json
```

See [full command reference](docs/commands.md) for all options.

## Trace Sources

agent-triage connects to five trace sources:

| Source | Flag | Setup |
|--------|------|-------|
| **JSON/JSONL** | `--traces file.json` | No setup needed |
| **LangSmith** | `--langsmith project` | Set `LANGSMITH_API_KEY` |
| **OpenTelemetry** | `--otel file.json` | OTLP/JSON export |
| **Langfuse** | `--langfuse` | Set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` |
| **Axiom** | `--axiom dataset` | Set `AXIOM_API_KEY` |

See [configuration docs](docs/configuration.md) for trace format details, config file reference, and programmatic API.

## MCP Server

AI assistants (Claude, Cursor, etc.) can debug your agents via MCP:

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

`agent-triage-mcp` is a binary included in the `agent-triage` npm package — no separate install needed.

Exposes 9 tools: `triage_status`, `triage_sample`, `triage_list_policies`, `triage_history`, `triage_diff` (all zero-cost), plus `triage_check`, `triage_explain`, `triage_init`, and `triage_analyze`.

## How It Compares

| Feature | agent-triage | IntellAgent | DeepEval | Promptfoo |
|---------|:-:|:-:|:-:|:-:|
| Production trace analysis | Yes | No | Partial | Partial |
| Policy extraction from prompts | Yes | No | No | No |
| Multi-connector (5 sources) | Yes | LangGraph only | Custom | Custom |
| Self-contained HTML report | Yes | No | **Dashboard UI** | No |
| Step-level root cause + cascade | Yes | No | No | No |
| Blast-radius warnings | Yes | No | No | No |
| MCP server for AI assistants | Yes | No | No | No |
| CI compliance gates | Yes | No | Yes | Yes |
| **Large community / ecosystem** | No | No | Yes | **Yes** |

> Comparison accurate as of March 2026. [Open an issue](https://github.com/converra/agent-triage/issues) if any entry needs updating. DeepEval and Promptfoo are mature projects with large communities — agent-triage focuses specifically on production diagnosis from system prompt policies.

## Limitations

- **Policy extraction works best with explicit rules.** Vague system prompts produce vague policies. Review extracted policies before trusting results.
- **LLM-as-judge can disagree with you.** The evaluator LLM interprets policies — its judgment may not always match yours. Use `policies.json` to refine definitions.
- **Non-deterministic.** Running the same evaluation twice may produce slightly different scores due to LLM variability.
- **Cost scales with conversations.** See the cost table above for per-model pricing. Use `--quick` (~60% cheaper) or a smaller model for larger batches.

## agent-triage vs. Converra

agent-triage is a standalone diagnostic tool. It gives you a complete picture of what's failing and why.

[Converra](https://converra.ai) is an optional next step that automates the fix cycle — prompt optimization, simulation testing, regression gating, continuous monitoring, and team collaboration.

## License

[MIT License](./LICENSE)

## Contributing

We welcome contributions, especially new trace connectors. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
git clone https://github.com/converra/agent-triage
cd agent-triage && npm install && npm run build && npm test
```

---

Built by [Converra](https://converra.ai)
