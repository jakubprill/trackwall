import { describe, expect, test } from "bun:test";
import { modelHint, modelSuggestions, providerModelsNote, unofferedModel } from "../src/lib/provider-models.ts";

describe("the models of the session profile's provider in the UI (ADR-194)", () => {
  test("a suggested model's hint is its context window in thousands or millions of tokens, and its format once known", () => {
    expect(modelHint({ id: "claude-opus-5.5", contextWindow: 200000, wireApi: null })).toBe("200k context");
    expect(modelHint({ id: "gemini-4-argon", contextWindow: 1000000, wireApi: null })).toBe("1M context");
    expect(modelHint({ id: "small", contextWindow: 32768, wireApi: null })).toBe("33k context");
    expect(modelHint({ id: "gpt-6.1-sol", contextWindow: null, wireApi: null })).toBe("");
    expect(modelHint({ id: "gpt-6.1-sol", contextWindow: 400000, wireApi: "responses" })).toBe("400k context · responses API");
    expect(modelHint({ id: "gpt-6.1-sol", contextWindow: null, wireApi: "completions" })).toBe("completions API");
  });

  test("under the session profile, a list says how many models the Model fields suggest", () => {
    const list = {
      profile: "byok",
      models: [
        { id: "a", contextWindow: null, wireApi: null },
        { id: "b", contextWindow: null, wireApi: null },
      ],
      problem: null,
    };
    expect(providerModelsNote(list)).toEqual({
      text: "The provider offers 2 models; the Model fields suggest them, and any other id can still be typed.",
      problem: false,
    });
  });

  test("a provider that could not be asked shows its problem, and no profile or no provider shows nothing", () => {
    const problem = "The model provider of the session profile did not accept its key when asked for its models (401).";
    expect(providerModelsNote({ profile: "byok", models: [], problem })).toEqual({ text: problem, problem: true });
    expect(providerModelsNote({ profile: null, models: [], problem: null })).toBeNull();
    expect(providerModelsNote({ profile: "byok", models: [], problem: null })).toBeNull();
  });
});

describe("a model id the provider does not offer (ADR-206)", () => {
  const models = [
    { id: "claude-sonnet-5.5", contextWindow: null, wireApi: null },
    { id: "gpt-6-luna", contextWindow: null, wireApi: null },
  ];

  test("an id the provider does not list is named with the offered id closest to it", () => {
    expect(unofferedModel("claude-sonnet-4.5", models)).toEqual({ closest: "claude-sonnet-5.5" });
  });

  test("an id like none of the offered ones is named without a guess", () => {
    expect(unofferedModel("o4", models)).toEqual({ closest: null });
  });

  test("auto the provider does not list is warned about like any other id, since Copilot CLI refuses it with a custom provider", () => {
    expect(unofferedModel("auto", models)).toEqual({ closest: null });
  });

  test("an offered id, an empty field and a provider without a list give no warning", () => {
    expect(unofferedModel("gpt-6-luna", models)).toBeNull();
    expect(unofferedModel("  ", models)).toBeNull();
    expect(unofferedModel("claude-sonnet-4.5", [])).toBeNull();
  });
});

describe("the suggestions of a Model field", () => {
  test("the provider's models are the suggestions, without Copilot CLI's auto in front of them", () => {
    expect(modelSuggestions([{ id: "gpt-6-luna", contextWindow: 400_000, wireApi: "responses" }])).toEqual([
      { id: "gpt-6-luna", hint: "400k context · responses API" },
    ]);
  });
});
