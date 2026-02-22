#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./init.js";

const program = new Command();

program
  .name("converra-triage")
  .description(
    "Triage your AI agents — extract policies, evaluate conversations, generate diagnostic reports.",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Extract testable policies from your agent's system prompt")
  .option("-p, --prompt <path>", "Path to the system prompt file")
  .option("-o, --output <path>", "Output path for policies.json", "policies.json")
  .option("--provider <provider>", "LLM provider (openai, anthropic, openai-compatible)")
  .option("--model <model>", "LLM model to use")
  .option("--api-key <key>", "LLM API key (or set env var)")
  .action(initCommand);

program.parse();
