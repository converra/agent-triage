# Changelog

## [0.1.0] - 2026-02-22

### CLI
- 9 commands: `init`, `analyze`, `explain`, `check`, `status`, `history`, `view`, `diff`, `demo`
- Time filters (`--since`, `--until`), agent filter (`--agent`), max conversations limit
- `--quick` mode for faster/cheaper analysis (skips diagnosis and fixes)
- `--dry-run` cost estimation before running evaluation
- `--format json` output for all evaluation commands
- `--threshold` exit code for CI gating on `check`
- `--summary-only` report generation without trace transcripts
- Provider-aware model defaults (OpenAI, Anthropic, OpenAI-compatible)
- Auto-create output directories

### Ingestion
- JSON, LangSmith, OpenTelemetry, Axiom, and Langfuse trace connectors
- Auto-discovery of agents and policies from traces (zero-config `analyze --langsmith`)
- LangSmith two-strategy auto-detection (session-based and standalone)
- Multi-agent trace composition into single conversations
- Session-based ingestion with rate-limit throttling

### Evaluation
- 12 quality metrics scoring per conversation
- Policy extraction from system prompts via LLM
- Policy compliance checking with pass/fail/not_applicable verdicts
- Root cause diagnosis with cascade chain, blast radius, and per-turn descriptions
- Per-policy directional fix generation with evidence-based recommendations
- Failure pattern aggregation across conversations
- Agent-scoped policies to prevent cross-contamination

### Report
- Self-contained HTML report with inline CSS/JS
- Dark mode support
- Step-by-step timeline with density-aware truncation and policy badges
- Root cause breakdown section with cascade visualization
- Collapsible conversation details with auto-expand
- Copy-all-fixes and save-as-markdown actions
- Cross-run diff comparison (`diff` command)
- Run history tracking across `analyze` runs (`history` command)

### MCP Server
- JSON-file-first ingestion with `triage_sample` tool
- Split into zero-cost read tools and LLM-cost eval tools
- Zod schema validation on all tool inputs

### Library
- Full programmatic API via `import { ... } from "agent-triage"`
- All connectors, evaluator, policy checker, diagnosis, fix generator, report builder, and diff exported
- Injectable logger (silent by default for library consumers)

### Infrastructure
- 275 unit tests across 23 test suites
- TypeScript strict mode, ESM with Node16 module resolution
- Security hardening (path traversal, JS escaping, prototype pollution)
- `llms.txt` and AI discoverability files for LLM/agent integration
- MIT license
