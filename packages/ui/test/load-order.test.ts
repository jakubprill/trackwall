import { describe, expect, test } from "bun:test";
import { LoadOrder } from "../src/lib/load-order.ts";

describe("order of view data", () => {
  test("the answer to a request sent before a WebSocket snapshot does not replace the snapshot", () => {
    const order = new LoadOrder();
    const question = order.next();
    const snapshot = order.next();
    expect(order.show(snapshot)).toBe(true);
    expect(order.show(question)).toBe(false);
    expect(order.isOutdated(question)).toBe(true);
  });

  test("the answer to a request sent after a snapshot replaces it, and the numbers count requests and snapshots together", () => {
    const order = new LoadOrder();
    expect(order.show(order.next())).toBe(true);
    const question = order.next();
    expect(order.issued()).toBe(2);
    expect(order.isOutdated(question)).toBe(false);
    expect(order.show(question)).toBe(true);
  });
});
