import { describe, expect, test } from "bun:test";
import { LoadOrder } from "../src/lib/load-order.ts";

describe("kolejność danych widoku", () => {
  test("odpowiedź na pytanie wysłane przed migawką z WebSocketu nie zastępuje migawki", () => {
    const order = new LoadOrder();
    const question = order.next();
    const snapshot = order.next();
    expect(order.show(snapshot)).toBe(true);
    expect(order.show(question)).toBe(false);
    expect(order.isOutdated(question)).toBe(true);
  });

  test("odpowiedź na pytanie wysłane po migawce zastępuje ją, a numery liczą pytania i migawki razem", () => {
    const order = new LoadOrder();
    expect(order.show(order.next())).toBe(true);
    const question = order.next();
    expect(order.issued()).toBe(2);
    expect(order.isOutdated(question)).toBe(false);
    expect(order.show(question)).toBe(true);
  });
});
