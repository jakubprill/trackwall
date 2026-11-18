import { describe, expect, test } from "bun:test";
import type { MergeRequestThread } from "@trackwall/protocol";
import { notesLeftOut, pickedThreads, sendBlocker, threadPlace, threadsSummary } from "../src/lib/merge-request-threads.ts";

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

  test("only the threads the user ticks go, each with the notes the user sees, and at most the 15 the agent takes at once", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => thread(String(i), null, null));

    expect(pickedThreads(twenty, new Set())).toEqual([]);
    expect(pickedThreads(twenty, new Set(["3", "1"]))).toEqual([
      { id: "1", notes: [{ author: "reviewer", text: "Name the constant.", at: "2026-11-16T10:00:00Z" }] },
      { id: "3", notes: [{ author: "reviewer", text: "Name the constant.", at: "2026-11-16T10:00:00Z" }] },
    ]);
    expect(sendBlocker(0)).toBe("Pick a thread to send.");
    expect(sendBlocker(15)).toBeNull();
    expect(sendBlocker(16)).toBe("The agent takes at most 15 threads at once.");
  });

  test("a thread with more replies than Trackwall reads says they stay on the repo host and do not reach the agent", () => {
    expect(notesLeftOut(thread("1", null, null))).toBeNull();
    expect(notesLeftOut({ ...thread("1", null, null), moreNotes: 1 })).toBe("1 later reply only on the repo host, not sent to the agent");
    expect(notesLeftOut({ ...thread("1", null, null), moreNotes: 4 })).toBe("4 later replies only on the repo host, not sent to the agent");
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
