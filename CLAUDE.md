# agent-triage

CLI tool, MCP server, and Node.js library for diagnosing AI agents in production. Extracts behavioral policies from system prompts, evaluates traces against them, generates diagnostic reports.

## Architecture

```
Traces (JSON/LangSmith/OTel)
  → Normalize to NormalizedConversation
  → Extract policies from system prompt (or use existing policies.json)
  → Evaluate: 12 metrics + policy compliance per conversation
  → Diagnose: root cause turn, cascade chain, blast radius, fix
  → Aggregate: failure patterns, recommendations
  → Report: self-contained HTML with inline CSS/JS
```

### Core Types
- `NormalizedConversation` — universal trace format, all connectors normalize to this (`src/ingestion/types.ts`)
- `Policy` — extracted behavioral rule with id, name, description, category, complexity (`src/policy/types.ts`)
- `PolicyResult` — per-conversation verdict (pass/fail/not_applicable) with evidence and failing turns (`src/evaluation/types.ts`)
- `Diagnosis` — root cause analysis: turn, agent, summary, impact, cascade chain, fix, blast radius (`src/evaluation/types.ts`)
- `Report` — final output: conversations, policies, metrics, failure patterns, recommendations (`src/evaluation/types.ts`)

### Key Modules
- `src/llm/client.ts` — unified LLM client (OpenAI + Anthropic), use `createLlmClient()`
- `src/llm/prompts.ts` — all prompt templates, return structured JSON
- `src/llm/json.ts` — safe JSON parsing for LLM responses (handles code fences, control chars, word-number coercion)
- `src/report/` — HTML report: `generator.ts` (entry), `sections.ts` (render functions), `styles.ts` (inline CSS/JS/icons)

## Rules

### ESM Imports
All imports use `.js` extensions even for `.ts` files. This is required by Node16 module resolution.
```typescript
// Correct
import { foo } from "./bar.js";
// Wrong — will fail at runtime
import { foo } from "./bar";
import { foo } from "./bar.ts";
```

### LLM Response Parsing
Never use raw `JSON.parse()` on LLM output. Always use `safeJSONParse()` from `src/llm/json.ts`.

### HTML Report
Reports are single self-contained HTML files. CSS and JS are inlined from `src/report/styles.ts`. After changing report code, rebuild with:
```bash
node --import tsx/esm -e "
import { readFileSync, writeFileSync } from 'fs';
import { buildHtml } from './src/report/generator.ts';
const report = JSON.parse(readFileSync('report.json', 'utf-8'));
writeFileSync('report.html', buildHtml(report), 'utf-8');
"
```

### Testing
- Vitest, tests in `test/` mirroring `src/` structure
- Mock LLM responses — never make real API calls in tests
- Run: `npm test` (all), `npx vitest run test/path/file.test.ts` (single)
- Type-check: `npm run lint` (runs `tsc --noEmit`)

### Code Style
- TypeScript strict mode, ESM
- Early returns over nesting
- Functions < 50 lines
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`
- Prefer editing existing files over creating new ones

### MCP Server
Split into zero-cost read tools (`src/mcp/tools-read.ts`) and LLM-cost eval tools (`src/mcp/tools-eval.ts`). Uses `registerTool()` with zod schemas. Tools must mirror CLI capabilities.

## Commands

```bash
npm run build          # Compile to dist/
npm test               # Run all tests
npm run lint           # Type-check
npm run dev -- <cmd>   # Run CLI from source (e.g., npm run dev -- analyze --traces data.json)
```
