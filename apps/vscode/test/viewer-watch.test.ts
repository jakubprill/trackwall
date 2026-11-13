import { describe, expect, test } from "bun:test";
import type { ViewerRead } from "../src/viewer-client.ts";
import { BACKGROUND_INTERVAL_MS, FOCUSED_INTERVAL_MS, watchSessions } from "../src/viewer-watch.ts";

describe("looking at the daemon again and again", () => {
  test("looks every 2 s while VS Code has the focus and every 10 s while it does not", () => {
    expect(FOCUSED_INTERVAL_MS).toBe(2000);
    expect(BACKGROUND_INTERVAL_MS).toBe(10_000);
  });

  test("looks once at the start, again at once on refresh, never two looks at a time, and stops when disposed", async () => {
    let looks = 0;
    let inFlight = 0;
    let most = 0;
    const reads: ViewerRead[] = [];
    const watch = watchSessions({
      folder: () => ({ path: "/state", ignoredSetting: null }),
      focused: () => true,
      onRead: (read, folder) => {
        expect(folder).toEqual({ path: "/state", ignoredSetting: null });
        reads.push(read);
      },
      read: async (folder) => {
        expect(folder).toBe("/state");
        looks++;
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { kind: "off" };
      },
    });
    watch.refresh();
    watch.refresh();
    await new Promise((r) => setTimeout(r, 150));
    expect(looks).toBe(2);
    expect(most).toBe(1);
    expect(reads).toEqual([{ kind: "off" }, { kind: "off" }]);
    watch.dispose();
    watch.refresh();
    await new Promise((r) => setTimeout(r, 100));
    expect(reads).toHaveLength(2);
  });
});
