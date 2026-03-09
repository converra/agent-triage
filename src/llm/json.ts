/**
 * Parse JSON from LLM responses, handling common quirks:
 * - Markdown code blocks (```json ... ```)
 * - Leading/trailing text
 * - Bare-word numbers (e.g., "score": Fifty)
 * - Trailing commas
 */
export function parseJsonResponse(raw: string): unknown {
  let cleaned = raw.trim();

  // Strip markdown code blocks (including truncated ones missing the closing fence)
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1]!.trim();
  } else {
    const openFenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*)/);
    if (openFenceMatch) {
      cleaned = openFenceMatch[1]!.trim();
    }
  }

  // Find the JSON boundary (first [ or { to last ] or })
  const firstBracket = findFirstJsonChar(cleaned);
  if (firstBracket >= 0) {
    const lastBracket = findLastJsonChar(cleaned);
    if (lastBracket > firstBracket) {
      cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }
  }

  // Fix trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  // Coerce bare-word numbers (e.g., "score": Fifty → "score": 50)
  cleaned = coerceWordNumbers(cleaned);

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Failed to parse LLM response as JSON. Raw response:\n${raw.slice(0, 500)}`,
    );
  }
}

function findFirstJsonChar(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") return i;
  }
  return -1;
}

function findLastJsonChar(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === "}" || s[i] === "]") return i;
  }
  return -1;
}

const WORD_NUMBERS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", twenty: "20", thirty: "30", forty: "40", fifty: "50",
  sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};

function coerceWordNumbers(json: string): string {
  return json.replace(
    /:\s*([A-Z][a-z]+)\b/g,
    (match, word: string) => {
      const num = WORD_NUMBERS[word.toLowerCase()];
      return num ? `: ${num}` : match;
    },
  );
}
