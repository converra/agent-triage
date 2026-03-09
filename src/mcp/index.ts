#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./server.js";
import { setLogger, consoleLogger } from "../logger.js";

setLogger(consoleLogger);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version: string };

const server = new McpServer(
  {
    name: "agent-triage",
    version: pkg.version,
  },
  {
    instructions: `agent-triage diagnoses AI agents in production by evaluating conversation traces against behavioral policies.

## Recommended workflow
1. **triage_status** — check if a report already exists (zero cost)
2. **Get a traces file** — export conversations as JSON (see format below)
3. **triage_sample** — inspect raw conversations before spending on LLM analysis
4. **triage_analyze** — full evaluation: metrics + policy compliance + diagnosis
5. **triage_explain** — deep-dive into the worst conversation

## Getting a traces file
Help the user export their conversations to a JSON file. The format is flexible:

\`\`\`json
[
  {
    "id": "conv-1",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant..."},
      {"role": "user", "content": "Hello"},
      {"role": "assistant", "content": "Hi! How can I help?"}
    ]
  }
]
\`\`\`

Accepted field variants (auto-detected):
- **id**: "id", "conversation_id", "thread_id", "session_id", "run_id", "uuid"
- **messages**: "messages", "turns", "conversation", "events", "steps", "chat_history"
- **role**: "role", "type", "sender", "from", "author" (values: user/human/customer, assistant/ai/bot/agent, system)
- **content**: "content", "text", "message", "body", "value", "output"
- **timestamp**: "timestamp", "created_at", "createdAt", "time", "date", "ts"
- Messages can also be \`[role, content]\` tuples or plain strings (alternating user/assistant)

### Platform export tips
- **LangSmith**: Datasets > Export as JSON, or use the SDK: \`client.list_runs(project_name=...) \`
- **LangFuse**: Traces > Export JSON from the UI, or use the API: \`GET /api/public/traces\`
- **Datadog**: LLM Observability > Export traces via API or notebook
- **Custom**: Any array of objects with messages — agent-triage normalizes automatically

## Tool selection guide
| Need | Tool | Cost |
|------|------|------|
| Current health overview | triage_status | Zero |
| Browse raw conversations | triage_sample | Zero |
| List loaded policies | triage_list_policies | Zero |
| Compare two reports | triage_diff | Zero |
| Compliance trend over time | triage_history | Zero |
| Open report in browser | triage_view | Zero |
| Check specific policies | triage_check | Moderate |
| Extract policies from prompt | triage_init | Moderate |
| Diagnose one conversation | triage_explain | Moderate |
| Full analysis + report | triage_analyze | High |
| Try with example data | triage_demo | High |`,
  },
);

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
