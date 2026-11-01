import { describe, expect, test } from "bun:test";
import { mergeRequestNumber, pipelineStateText } from "../src/merge-requests.ts";

describe("a merge request's number", () => {
  test("is written as each repo host writes it", () => {
    expect(mergeRequestNumber({ kind: "gitlab", host: "gitlab.example.com", path: "shop/shop" }, 12)).toBe("!12");
    expect(mergeRequestNumber({ kind: "github", host: "github.com", path: "me/shop" }, 7)).toBe("#7");
  });
});

describe("a pipeline's state in words", () => {
  test("names the state, and a pipeline held at a manual job says it waits for it", () => {
    expect(pipelineStateText("failed")).toBe("pipeline failed");
    expect(pipelineStateText("manual")).toBe("pipeline waits for a manual job");
  });
});
