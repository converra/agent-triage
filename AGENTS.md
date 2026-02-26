# Agent Instructions for agent-triage

This file provides context for AI coding agents working on this codebase.

## Project Summary

agent-triage is a CLI tool, MCP server, and Node.js library for diagnosing AI agents in production. It extracts behavioral policies from system prompts, evaluates traces against them, and generates diagnostic reports.

## Tech Stack

- **Language:** TypeScript (strict mode, ESM)
- **Runtime:** Node.js >= 18
- **Test framework:** Vitest
- **Package manager:** npm
- **Build:** `tsc` (no bundler)
- **MCP SDK:** `@modelcontextprotocol/sdk@1.27.1` with `registerTool()` API and zod schemas

## Project Structure

```
src/
  cli/          — CLI commands (commander-based)
  ingestion/    — Trace connectors (json, langsmith, otel, auto-discovery)
  evaluation/   — LLM-based evaluation (evaluator, policy-checker, diagnosis, fix-generator, runner)
  aggregation/  — Policy and metric aggregation
  llm/          — LLM client abstraction (OpenAI + Anthropic), prompt templates
  policy/       — Policy types and extraction
  report/       — HTML report generation
  diff/         — Cross-run report comparison
  config/       — Config loading, defaults, schema
  mcp/          — MCP server (server.ts, tools-read.ts, tools-eval.ts, helpers.ts)
  history.ts    — Run history tracking
  index.ts      — Public API exports
test/           — Unit tests (mirror src/ structure)
data/           — Built-in demo data
```

## Key Commands

```bash
npm run build        # Compile TypeScript to dist/
npm test             # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run lint         # Type-check without emitting
npm run dev -- <cmd> # Run CLI from source
```

## Code Conventions

- ESM modules with `.js` extensions in imports (TypeScript convention for ESM output)
- Early returns over nested conditionals
- Small, focused functions (< 50 lines)
- Explicit over implicit
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`

## Architecture Notes

- The LLM client (`src/llm/client.ts`) abstracts OpenAI and Anthropic behind a unified interface
- Prompt templates are in `src/llm/prompts.ts` — they return structured JSON responses parsed by `src/llm/json.ts`
- The evaluation pipeline: extract policies -> evaluate each conversation -> aggregate results -> generate diagnosis -> generate report
- The MCP server exposes the same functionality as the CLI, split into zero-cost read tools and LLM-cost eval tools
- Configuration supports env var interpolation (`${VAR_NAME}`) and YAML config files
- HTML reports are self-contained single files with inline CSS/JS

## Testing

- Tests live in `test/` and mirror the `src/` directory structure
- Use `vitest` — tests run with `npm test`
- Mock LLM responses in tests rather than making real API calls
- Test files use `.test.ts` extension

## Important Patterns

- `NormalizedConversation` is the universal trace format — all connectors normalize to this
- `Policy` objects have an `id`, `name`, `description`, `category`, and `severity`
- The `Report` type is the final output containing conversations, policies, metrics, and recommendations
- Progress tracking uses `.agent-triage-progress.json` (gitignored)
- Run history is stored in `.triage-history.jsonl` (gitignored)
