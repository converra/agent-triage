# Changelog

## [0.2.1] - 2026-10-14

### Fixed
- Ship the post-0.2.0 CLI, MCP, evaluation, and report fixes: provider-aware
  dry-run costs, empty filtered-input errors, bounded diagnosis turns, validated
  policy failure types, quality averages excluding truncation flags, and safely
  escaped report copy commands.
- Keep MCP diagnostics on stderr, accept all supported trace sources for explain,
  report skipped policy checks, and annotate read-only tools.
- Include linked command/configuration/workflow docs, README screenshots, and
  the changelog in the npm package. Build fresh output before packing.
- Update vulnerable dependencies within existing runtime major versions.

### Release tooling
- Add zero-cost MCP `--help`/`-h`.
- Upgrade the development-only Vitest runner to 4.1.11 or later. Full tests run
  on Node 20.19+, 22, and 24; packed runtime smoke checks retain Node 18 support.
- Add tag-driven npm trusted publishing with OIDC, provenance, and explicit
  version/main ancestry checks. Publisher registration remains a maintainer step.

## [0.2.0] - 2026-03-09

### CLI
- `demo` command accepts example name as argument (`npx agent-triage demo customer-support`)
- Auto-detect API key from any available provider (Anthropic or OpenAI)
- Auto-load `.env` file — no manual `export` needed
- Replace interactive API key prompt with clear, actionable error message
- Switch default model to claude-sonnet-4-6

### Evaluation
- Parallelize diagnosis and fix generation LLM calls for faster runs
- Add severity floors to prevent false low scores

### Report
- Add "Copy all fixes" batch action in recommendations section
- Add "Save as .md" export for individual fixes
- Improve information hierarchy — concise, scannable text
- Rename "Retrieval Rag Issue" to "RAG Issue"
- Structured fix instructions with blast radius

### MCP Server
- Add `triage_view` and `triage_demo` tools

### Ingestion
- Fix Langfuse trace metadata (agentName, tags, sessionId)

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
