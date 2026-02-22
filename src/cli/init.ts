import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/loader.js";
import { createLlmClient } from "../llm/client.js";
import { extractPolicies } from "../policy/extractor.js";
import { estimateCost } from "../config/defaults.js";

interface InitOptions {
  prompt?: string;
  output: string;
  provider?: string;
  model?: string;
  apiKey?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const promptPath = options.prompt;

  if (!promptPath) {
    console.error(
      "Error: No prompt file specified.\n" +
        "Usage: converra-triage init --prompt ./system-prompt.txt",
    );
    process.exit(1);
  }

  const resolvedPromptPath = resolve(process.cwd(), promptPath);

  let systemPrompt: string;
  try {
    systemPrompt = await readFile(resolvedPromptPath, "utf-8");
  } catch {
    console.error(
      `Error: Could not read prompt file at ${resolvedPromptPath}\n` +
        "Check that the file exists and is readable.",
    );
    process.exit(1);
  }

  if (systemPrompt.trim().length === 0) {
    console.error("Error: Prompt file is empty.");
    process.exit(1);
  }

  console.log(`Reading prompt from ${resolvedPromptPath}`);
  console.log(
    `Prompt length: ${systemPrompt.length} characters (${systemPrompt.split("\n").length} lines)`,
  );

  // Load config with CLI overrides
  const overrides: Record<string, unknown> = {
    prompt: { path: promptPath },
  };
  const llmOverrides: Record<string, unknown> = {};
  if (options.provider) llmOverrides.provider = options.provider;
  if (options.model) llmOverrides.model = options.model;
  if (options.apiKey) llmOverrides.apiKey = options.apiKey;
  if (Object.keys(llmOverrides).length > 0) overrides.llm = llmOverrides;

  const config = await loadConfig(overrides);

  const apiKey = resolveApiKey(config);
  const llm = createLlmClient(
    config.llm.provider,
    apiKey,
    config.llm.model,
    config.llm.baseUrl,
  );

  console.log(`\nUsing ${config.llm.provider}/${config.llm.model}`);
  console.log("Extracting policies...\n");

  const policies = await extractPolicies(llm, systemPrompt);

  const outputPath = resolve(process.cwd(), options.output);
  await writeFile(outputPath, JSON.stringify(policies, null, 2), "utf-8");

  const usage = llm.getUsage();
  const cost = estimateCost(
    config.llm.model,
    usage.inputTokens,
    usage.outputTokens,
  );

  console.log(`Extracted ${policies.length} policies from your prompt.\n`);

  // Summary by category
  const byCategory = new Map<string, number>();
  for (const policy of policies) {
    byCategory.set(policy.category, (byCategory.get(policy.category) ?? 0) + 1);
  }
  for (const [category, count] of [...byCategory.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${category}: ${count}`);
  }

  console.log(`\nPolicies written to ${outputPath}`);
  console.log(
    `Cost: ~$${cost.toFixed(4)} (${usage.inputTokens + usage.outputTokens} tokens)`,
  );
  console.log(
    "\nReview and edit policies.json before running analysis.",
  );
}
