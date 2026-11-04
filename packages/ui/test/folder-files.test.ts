import { afterEach, describe, expect, test } from "bun:test";
import { download, errorCode, errorMessage } from "../src/lib/api.ts";
import { entryAction, entryPath } from "../src/lib/folder-files.ts";
import { formatBytes } from "../src/lib/format.ts";

describe("the Files panel of the Shell tab", () => {
  test("an entry's path joins its folder and name with a slash, and the folder itself is empty", () => {
    expect(entryPath("", "build")).toBe("build");
    expect(entryPath("build/libs", "shop-1.0.jar")).toBe("build/libs/shop-1.0.jar");
  });

  test("a folder opens, a file downloads, and a link or anything else does nothing", () => {
    expect(entryAction({ name: "build", kind: "folder", size: null })).toBe("open");
    expect(entryAction({ name: "app.jar", kind: "file", size: 12 })).toBe("download");
    expect(entryAction({ name: "root", kind: "link", size: null })).toBeNull();
    expect(entryAction({ name: "fifo", kind: "other", size: null })).toBeNull();
  });

  test("a size over a gigabyte is named in GB", () => {
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
  });
});

describe("downloading a file from the daemon", () => {
  const conn = { baseUrl: "http://127.0.0.1:7700", token: "secret" };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A daemon that answers every request with `res` and records what it was asked. */
  function daemonAnswering(res: Response): Request[] {
    const asked: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        asked.push(new Request(input, init));
        return res;
      },
      { preconnect: realFetch.preconnect },
    );
    return asked;
  }

  test("posts the place path with the token and hands back the bytes", async () => {
    const asked = daemonAnswering(new Response("PK jar bytes", { headers: { "content-type": "application/octet-stream" } }));

    const blob = await download(conn, "/api/terminals/download", { repo: "shop", task: null, path: "build/app.jar" });

    expect(await blob.text()).toBe("PK jar bytes");
    expect(asked[0]?.method).toBe("POST");
    expect(asked[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(await asked[0]?.json()).toEqual({ repo: "shop", task: null, path: "build/app.jar" });
  });

  test("a refusal throws with the daemon's code and message", async () => {
    daemonAnswering(Response.json({ ok: false, error: { code: "bad_request", message: "build is not a regular file" } }, { status: 400 }));

    const failed = await download(conn, "/api/terminals/download", { repo: "shop", task: null, path: "build" }).catch(
      (err: unknown) => err,
    );

    expect(errorCode(failed)).toBe("bad_request");
    expect(errorMessage(failed)).toBe("build is not a regular file");
  });
});
