import { describe, expect, test } from "bun:test";
import type { MergeRequestThread } from "@trackwall/protocol";
import { firstPicks, sendBlocker, threadPlace, threadsSummary } from "../src/lib/merge-request-threads.ts";

const thread = (id: string, file: string | null, line: MergeRequestThread["line"]): MergeRequestThread => ({
  id,
  file,
  line,
  url: `https://gitlab.example.com/shop/-/merge_requests/12#note_${id}`,
  notes: [{ author: "reviewer", text: "Name the constant.", at: "2026-11-16T10:00:00Z" }],
  moreNotes: 0,
});

describe("the unresolved threads of a merge request in the task panel", () => {
  test("a thread is placed on its line, a removed line, its file, or the merge request as a whole", () => {
    expect(threadPlace(thread("1", "src/cart.ts", { side: "new", number: 14 }))).toBe("src/cart.ts:14");
    expect(threadPlace(thread("2", "src/cart.ts", { side: "old", number: 30 }))).toBe("src/cart.ts:30 (removed line)");
    expect(threadPlace(thread("3", "src/cart.ts", null))).toBe("src/cart.ts");
    expect(threadPlace(thread("4", null, null))).toBe("the merge request");
  });

  test("every thread is picked at first, up to the 15 the agent takes at once", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => thread(String(i), null, null));

    expect([...firstPicks(twenty)]).toEqual(Array.from({ length: 15 }, (_, i) => String(i)));
    expect(sendBlocker(15)).toBeNull();
    expect(sendBlocker(16)).toBe("The agent takes at most 15 threads at once.");
    expect(sendBlocker(0)).toBe("Pick a thread to send.");
  });

  test("the summary counts the threads and says when the repo host has more than were read", () => {
    const one = [thread("1", null, null)];
    expect(threadsSummary({ mergeRequest: "", threads: [], more: false })).toBe("No unresolved threads.");
    expect(threadsSummary({ mergeRequest: "", threads: one, more: false })).toBe("1 unresolved thread.");
    expect(threadsSummary({ mergeRequest: "", threads: [...one, ...one], more: true })).toBe(
      "2 unresolved threads. The merge request has more than Trackwall reads: open it for the rest.",
    );
  });
});
