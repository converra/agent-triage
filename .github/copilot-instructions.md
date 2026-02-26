# Copilot Instructions for agent-triage

## Project Context

agent-triage is a TypeScript CLI tool, MCP server, and library for diagnosing AI agents in production. It extracts behavioral policies from system prompts, evaluates traces, and generates diagnostic reports.

## Code Style

- TypeScript strict mode, ESM modules
- Use `.js` extensions in import paths (TypeScript ESM convention)
- Early returns, small functions, descriptive names
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`

## Key Patterns

- All trace connectors normalize to `NormalizedConversation` from `src/ingestion/types.ts`
- LLM calls go through `createLlmClient()` from `src/llm/client.ts`
- Prompt templates in `src/llm/prompts.ts` return structured JSON
- MCP tools use `registerTool()` with zod schemas
- Tests use vitest, mock LLM responses, live in `test/`

## When Suggesting Code

- Prefer editing existing files over creating new ones
- Follow the existing patterns in the nearest similar file
- Add tests for new functionality in the corresponding `test/` path
- Run `npm test` and `npm run lint` to verify changes
