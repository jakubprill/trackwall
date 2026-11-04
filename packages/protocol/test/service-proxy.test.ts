import { describe, expect, test } from "bun:test";
import { isServiceProxyOrigin, serviceProxyAddress, serviceProxyTarget } from "../src/service-proxy.ts";

const TASK = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("addresses of the service proxy (ADR-189)", () => {
  test("a repo's service opens at its name under localhost, a task's at the task id before it", () => {
    expect(serviceProxyAddress(7701, { repo: "shop", task: null })).toBe("http://shop.localhost:7701/");
    expect(serviceProxyAddress(7701, { repo: "shop", task: TASK })).toBe(`http://${TASK}.shop.localhost:7701/`);
  });

  test("the Host of an address names the service it was built for, also with dots in the repo id and in capitals", () => {
    expect(serviceProxyTarget("shop.localhost:7701", 7701)).toEqual({ repo: "shop", task: null });
    expect(serviceProxyTarget(`${TASK}.shop.localhost:7701`, 7701)).toEqual({ repo: "shop", task: TASK });
    expect(serviceProxyTarget("shop.api.localhost:7701", 7701)).toEqual({ repo: "shop.api", task: null });
    expect(serviceProxyTarget(`${TASK}.shop.api.localhost:7701`, 7701)).toEqual({ repo: "shop.api", task: TASK });
    expect(serviceProxyTarget("Shop.LOCALHOST:7701", 7701)).toEqual({ repo: "shop", task: null });
  });

  test("a Host that is not a service's name on the proxy's port names nothing", () => {
    for (const host of [
      undefined,
      "",
      "localhost:7701",
      ".localhost:7701",
      "127.0.0.1:7701",
      "shop.localhost:7700",
      "shop.localhost",
      "shop.evil.example:7701",
      "shop.localhost.evil.example:7701",
      "-shop.localhost:7701",
      "sh op.localhost:7701",
      `${"a".repeat(65)}.localhost:7701`,
    ])
      expect({ host, target: serviceProxyTarget(host, 7701) }).toEqual({ host, target: null });
  });

  test("only a page served through the proxy on its port counts as a service's origin", () => {
    expect(isServiceProxyOrigin("http://web.localhost:7701", 7701)).toBe(true);
    expect(isServiceProxyOrigin("https://web.localhost:7701", 7701)).toBe(false);
    expect(isServiceProxyOrigin("http://127.0.0.1:7700", 7701)).toBe(false);
    expect(isServiceProxyOrigin("http://localhost:7701", 7701)).toBe(false);
    expect(isServiceProxyOrigin("null", 7701)).toBe(false);
    expect(isServiceProxyOrigin("https://evil.example", 7701)).toBe(false);
  });
});
