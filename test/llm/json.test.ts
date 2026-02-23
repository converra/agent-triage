import { describe, it, expect } from "vitest";
import { parseJsonResponse } from "../../src/llm/json.js";

describe("parseJsonResponse", () => {
  it("parses plain JSON object", () => {
    const result = parseJsonResponse('{"score": 85}');
    expect(result).toEqual({ score: 85 });
  });

  it("parses plain JSON array", () => {
    const result = parseJsonResponse('[{"id": "a"}, {"id": "b"}]');
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("strips markdown code blocks", () => {
    const result = parseJsonResponse('```json\n{"score": 42}\n```');
    expect(result).toEqual({ score: 42 });
  });

  it("strips markdown code blocks without json tag", () => {
    const result = parseJsonResponse('```\n{"score": 42}\n```');
    expect(result).toEqual({ score: 42 });
  });

  it("strips leading and trailing text", () => {
    const result = parseJsonResponse(
      'Here is the result:\n{"score": 90}\nDone!',
    );
    expect(result).toEqual({ score: 90 });
  });

  it("fixes trailing commas", () => {
    const result = parseJsonResponse('{"a": 1, "b": 2, }');
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("fixes trailing commas in arrays", () => {
    const result = parseJsonResponse('[1, 2, 3, ]');
    expect(result).toEqual([1, 2, 3]);
  });

  it("coerces bare-word numbers", () => {
    const result = parseJsonResponse('{"score": Fifty}');
    expect(result).toEqual({ score: 50 });
  });

  it("coerces multiple bare-word numbers", () => {
    const result = parseJsonResponse(
      '{"a": Twenty, "b": Hundred, "c": Zero}',
    );
    expect(result).toEqual({ a: 20, b: 100, c: 0 });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonResponse("not json at all")).toThrow(
      "Failed to parse LLM response as JSON",
    );
  });

  it("handles nested objects", () => {
    const result = parseJsonResponse(
      '{"metrics": {"successScore": 80, "clarity": 90}}',
    );
    expect(result).toEqual({ metrics: { successScore: 80, clarity: 90 } });
  });

  it("handles whitespace-heavy responses", () => {
    const result = parseJsonResponse('\n\n  { "a" : 1 }  \n\n');
    expect(result).toEqual({ a: 1 });
  });
});
