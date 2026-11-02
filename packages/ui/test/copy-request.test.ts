import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import { copyRequestPreview, shownCopyRequest } from "../src/lib/copy-request.ts";

const request = { id: "r1", text: "mvn verify", at: "2026-11-02T15:00:00.000Z" };

describe("the copy request strip", () => {
  test("shows the request of a running session and hides it once the session has ended or when there is none", () => {
    const running = { run: { kind: "running" }, copyRequest: request } as Session;
    expect(shownCopyRequest(running)).toEqual(request);
    expect(shownCopyRequest({ ...running, run: { kind: "exited" } } as Session)).toBeNull();
    expect(shownCopyRequest({ ...running, copyRequest: null })).toBeNull();
    expect(shownCopyRequest(undefined)).toBeNull();
  });

  test("names the text by its first line that is not blank and counts its lines", () => {
    expect(copyRequestPreview("mvn verify")).toEqual({ firstLine: "mvn verify", lines: 1 });
    expect(copyRequestPreview("\n  cd orders\r\nmvn verify\n")).toEqual({ firstLine: "cd orders", lines: 4 });
    expect(copyRequestPreview("   ")).toEqual({ firstLine: "", lines: 1 });
  });
});
