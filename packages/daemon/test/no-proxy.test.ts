import { describe, expect, test } from "bun:test";
import { withLoopbackNoProxy } from "../src/modules/agents/no-proxy.ts";

describe("127.0.0.1 in NO_PROXY for the daemon's own sessions", () => {
  test("without NO_PROXY the session gets NO_PROXY=127.0.0.1", () => {
    expect(withLoopbackNoProxy({ HTTP_PROXY: "http://proxy:8080" })).toEqual({ HTTP_PROXY: "http://proxy:8080", NO_PROXY: "127.0.0.1" });
  });

  test("the user's NO_PROXY keeps its hosts, gets 127.0.0.1 after them and only once", () => {
    expect(withLoopbackNoProxy({ NO_PROXY: "localhost, .corp.example" }).NO_PROXY).toBe("localhost,.corp.example,127.0.0.1");
    expect(withLoopbackNoProxy({ NO_PROXY: "127.0.0.1,localhost" }).NO_PROXY).toBe("127.0.0.1,localhost");
    expect(withLoopbackNoProxy({ NO_PROXY: "" }).NO_PROXY).toBe("127.0.0.1");
  });

  test.skipIf(process.platform === "win32")("a lower-case no_proxy gets 127.0.0.1 too, and no NO_PROXY that would hide it", () => {
    expect(withLoopbackNoProxy({ no_proxy: "localhost" })).toEqual({ no_proxy: "localhost,127.0.0.1" });
    expect(withLoopbackNoProxy({ no_proxy: "a", NO_PROXY: "b" })).toEqual({ no_proxy: "a,127.0.0.1", NO_PROXY: "b,127.0.0.1" });
  });

  test.if(process.platform === "win32")("on Windows the user's spelling of the name is kept, not a second variable", () => {
    expect(withLoopbackNoProxy({ No_Proxy: "localhost" })).toEqual({ No_Proxy: "localhost,127.0.0.1" });
  });
});
