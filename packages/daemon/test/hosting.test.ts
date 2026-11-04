import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteRepoSearch } from "@trackwall/protocol";
import { Hosting } from "../src/modules/vcs/hosting.ts";
import { fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com" } as const;
const GITHUB = { kind: "github", host: "github.com" } as const;

const githubRepo = (fullName: string, archived = false, more: { language?: string | null; topics?: string[] } = {}) => ({
  full_name: fullName,
  description: `description of ${fullName}`,
  html_url: `https://github.com/${fullName}`,
  pushed_at: "2026-10-01T10:00:00Z",
  archived,
  ...more,
});

const gitlabProject = (path: string, topics?: string[]) => ({
  path_with_namespace: path,
  description: "",
  web_url: `https://gitlab.example.com/${path}`,
  last_activity_at: "2026-10-20T08:00:00Z",
  ...(topics ? { topics } : {}),
});

/** The first page of the user's repos without filters, as the "Add repo" view first asks. */
const search = (query: string, more: Partial<RemoteRepoSearch> = {}): RemoteRepoSearch => ({
  query,
  scope: "member",
  topic: "",
  language: "",
  starredOnHost: false,
  pages: 1,
  ...more,
});

/** The query of the `api` path of a fake `gh` or `glab` call. */
const apiQuery = (call: { args: string[] } | undefined) => new URL(call?.args[3] ?? "", "https://x/").searchParams;

describe("repo hosts through gh and glab", () => {
  test("GitLab searches on its side, in the path with the group, and glab gets the host name", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("shop/orders/orders-bff")] });

    const result = await hosting.repos(GITLAB, search("orders bff"));

    expect(result).toEqual({
      repos: [
        {
          fullName: "shop/orders/orders-bff",
          description: null,
          webUrl: "https://gitlab.example.com/shop/orders/orders-bff",
          updatedAt: "2026-10-20T08:00:00Z",
          topics: [],
        },
      ],
      more: "none",
    });
    const [call] = calls();
    expect(call?.args.slice(0, 3)).toEqual(["api", "--hostname", "gitlab.example.com"]);
    expect(call?.args[3]).toContain("membership=true");
    expect(call?.args[3]).toContain("search=orders%20bff&search_namespaces=true");
    expect(call?.env).toMatchObject({ GITLAB_HOST: "gitlab.example.com", NO_PROMPT: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  test("GitLab fetches the pages asked for, a full last page offers the next one, and Show more fetches only the new page", async () => {
    const { hosting, calls } = fakeHosting({ repos: Array.from({ length: 150 }, (_, i) => gitlabProject(`group/repo-${i}`)) });

    const first = await hosting.repos(GITLAB, search(""));
    expect(first.repos).toHaveLength(100);
    expect(first.more).toBe("next-page");
    expect(calls()[0]?.args[3]).not.toContain("search=");

    const two = await hosting.repos(GITLAB, search("", { pages: 2 }));
    expect(two.repos).toHaveLength(150);
    expect(two.repos[100]?.fullName).toBe("group/repo-100");
    expect(two.more).toBe("none");
    expect(calls().map((c) => apiQuery(c).get("page"))).toEqual(["1", "2"]);
  });

  test("GitLab stops at 10 pages, and then only a narrower search finds the rest", async () => {
    const { hosting, calls } = fakeHosting({ repos: Array.from({ length: 1001 }, (_, i) => gitlabProject(`group/repo-${i}`)) });

    const result = await hosting.repos(GITLAB, search("", { pages: 10 }));

    expect(result.repos).toHaveLength(1000);
    expect(result.more).toBe("narrow");
    expect(calls()).toHaveLength(10);
  });

  test("GitLab filters by scope, topic, language and the user's stars on its side, and the row gets the topics", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("shop/orders-api", ["java", "orders"])] });

    const result = await hosting.repos(
      GITLAB,
      search("orders", { scope: "visible", topic: "Java", language: "Java", starredOnHost: true }),
    );

    expect(result.repos.map((r) => [r.fullName, r.topics])).toEqual([["shop/orders-api", ["java", "orders"]]]);
    const query = apiQuery(calls()[0]);
    expect(query.get("membership")).toBeNull();
    expect(query.get("topic")).toBe("Java");
    expect(query.get("with_programming_language")).toBe("Java");
    expect(query.get("starred")).toBe("true");
    expect(query.get("search")).toBe("orders");
  });

  test("GitLab's member scope asks only for projects the user is a member of", async () => {
    const { hosting, calls } = fakeHosting({ repos: [] });

    await hosting.repos(GITLAB, search(""));

    const query = apiQuery(calls()[0]);
    expect(query.get("membership")).toBe("true");
    expect(query.get("starred")).toBeNull();
    expect(query.get("topic")).toBeNull();
    expect(query.get("with_programming_language")).toBeNull();
  });

  test("GitHub filters by topic and language in the daemon, ignoring case", async () => {
    const { hosting } = fakeHosting({
      repos: [
        githubRepo("me/api", false, { language: "Java", topics: ["spring", "orders"] }),
        githubRepo("me/web", false, { language: "TypeScript", topics: ["orders"] }),
        githubRepo("me/bare", false, { language: null }),
      ],
    });

    expect((await hosting.repos(GITHUB, search("", { topic: "ORDERS" }))).repos.map((r) => r.fullName)).toEqual(["me/api", "me/web"]);
    expect((await hosting.repos(GITHUB, search("", { language: "java" }))).repos.map((r) => r.fullName)).toEqual(["me/api"]);
    expect((await hosting.repos(GITHUB, search("", { topic: "orders", language: "typescript" }))).repos.map((r) => r.topics)).toEqual([
      ["orders"],
    ]);
  });

  test("a repo on two pages, after it moved between their fetches, shows once", async () => {
    const page = Array.from({ length: 100 }, (_, i) => gitlabProject(`group/repo-${i}`));
    const { hosting } = fakeHosting({ apiResponses: { projects: page } });

    const result = await hosting.repos(GITLAB, search("", { pages: 2 }));

    expect(result.repos.map((r) => r.fullName)).toEqual(page.map((p) => p.path_with_namespace));
  });

  test("GitHub does not fetch its pages again for a new topic, language or scope, which the daemon applies", async () => {
    const { hosting, calls } = fakeHosting({ repos: [githubRepo("me/api", false, { language: "Java", topics: ["orders"] })] });

    await hosting.repos(GITHUB, search(""));
    await hosting.repos(GITHUB, search("", { topic: "orders" }));
    await hosting.repos(GITHUB, search("", { language: "Java", scope: "visible" }));

    expect(calls()).toHaveLength(1);
  });

  test("GitHub's stars come from the user's starred list", async () => {
    const { hosting, calls } = fakeHosting({ repos: [githubRepo("someone/tool")] });

    expect((await hosting.repos(GITHUB, search("", { starredOnHost: true }))).repos.map((r) => r.fullName)).toEqual(["someone/tool"]);
    expect(calls()[0]?.args[3]).toStartWith("user/starred?");
  });

  test("GitHub fetches pages to the end, skips archived repos and filters by name or description", async () => {
    const repos = [
      ...Array.from({ length: 100 }, (_, i) => githubRepo(`me/other-${i}`)),
      githubRepo("me/trackwall"),
      githubRepo("me/old-trackwall", true),
    ];
    const { hosting, calls } = fakeHosting({ repos });

    const result = await hosting.repos(GITHUB, search("TRACKWALL"));

    expect(result).toEqual({
      repos: [
        {
          fullName: "me/trackwall",
          description: "description of me/trackwall",
          webUrl: "https://github.com/me/trackwall",
          updatedAt: "2026-10-01T10:00:00Z",
          topics: [],
        },
      ],
      more: "none",
    });
    expect(calls().map((c) => apiQuery(c).get("page"))).toEqual(["1", "2"]);
    expect(calls()[0]?.env).toMatchObject({ GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" });
  });

  test("GitLab gets a query shorter than 3 characters without search, and the daemon matches it itself", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("shop/tw"), gitlabProject("shop/api")] });

    expect((await hosting.repos(GITLAB, search("TW"))).repos.map((r) => r.fullName)).toEqual(["shop/tw"]);
    expect(calls()[0]?.args[3]).not.toContain("search=");
  });

  test("a later search filtered in the daemon does not ask the repo host again, and a failed question does not stay in memory", async () => {
    const { hosting, calls } = fakeHosting({ repos: [githubRepo("me/trackwall"), githubRepo("me/pawn")] });
    await hosting.repos(GITHUB, search("track"));
    expect((await hosting.repos(GITHUB, search("pawn"))).repos.map((r) => r.fullName)).toEqual(["me/pawn"]);
    expect(calls()).toHaveLength(1);

    const failing = fakeHosting({ apiErrors: { "github.com": "gh: no network" } });
    await expect(failing.hosting.repos(GITHUB, search(""))).rejects.toThrow("no network");
    await expect(failing.hosting.repos(GITHUB, search(""))).rejects.toThrow("no network");
    expect(failing.calls()).toHaveLength(2);
  });

  test("a name that could be a program option does not get onto the list", async () => {
    const { hosting } = fakeHosting({ repos: [githubRepo("me/-x"), githubRepo("me/ok")] });
    expect((await hosting.repos(GITHUB, search(""))).repos.map((r) => r.fullName)).toEqual(["me/ok"]);
  });

  test("a glab error comes back with the message from stderr, and a response that does not match the API with a description without a dump", async () => {
    await expect(
      fakeHosting({ apiErrors: { "gitlab.example.com": "glab: 401 Unauthorized" } }).hosting.repos(GITLAB, search("")),
    ).rejects.toThrow("401 Unauthorized");
    await expect(fakeHosting({ apiRaw: '{"message":"not a list"}' }).hosting.repos(GITLAB, search(""))).rejects.toThrow(
      "glab api returned a response that does not match the gitlab.example.com API",
    );
  });

  test("a program missing from PATH is a readable message", async () => {
    const hosting = new Hosting({
      github: { command: "trackwall-no-such-gh", args: [] },
      gitlab: { command: "trackwall-no-such-glab", args: [] },
    });
    await expect(hosting.repos(GITLAB, search(""))).rejects.toThrow("program trackwall-no-such-glab not found in PATH");
  });

  test("clone calls repo clone with the full name and directory, without an inherited GIT_DIR", async () => {
    const { hosting, calls } = fakeHosting();
    const dest = join(mkdtempSync(join(tmpdir(), "trackwall-clone-")), "orders-bff");
    process.env.GIT_DIR = "/somewhere/else";
    try {
      await hosting.clone(GITLAB, "shop/orders-bff", dest);
    } finally {
      delete process.env.GIT_DIR;
    }

    expect(calls()).toEqual([
      {
        args: ["repo", "clone", "shop/orders-bff", dest],
        env: { GITLAB_HOST: "gitlab.example.com", NO_PROMPT: "1", GIT_TERMINAL_PROMPT: "0" },
      },
    ]);
  });
});
