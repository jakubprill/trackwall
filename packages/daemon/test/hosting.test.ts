import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hosting } from "../src/modules/vcs/hosting.ts";
import { fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com" } as const;
const GITHUB = { kind: "github", host: "github.com" } as const;

const githubRepo = (fullName: string, archived = false) => ({
  full_name: fullName,
  description: `description of ${fullName}`,
  html_url: `https://github.com/${fullName}`,
  pushed_at: "2026-10-01T10:00:00Z",
  archived,
});

const gitlabProject = (path: string) => ({
  path_with_namespace: path,
  description: "",
  web_url: `https://gitlab.example.com/${path}`,
  last_activity_at: "2026-10-20T08:00:00Z",
});

describe("repo hosts through gh and glab", () => {
  test("GitLab searches on its side, in the path with the group, and glab gets the host name", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("shop/orders/orders-bff")] });

    const result = await hosting.repos(GITLAB, "orders bff");

    expect(result).toEqual({
      repos: [
        {
          fullName: "shop/orders/orders-bff",
          description: null,
          webUrl: "https://gitlab.example.com/shop/orders/orders-bff",
          updatedAt: "2026-10-20T08:00:00Z",
        },
      ],
      truncated: false,
    });
    const [call] = calls();
    expect(call?.args.slice(0, 3)).toEqual(["api", "--hostname", "gitlab.example.com"]);
    expect(call?.args[3]).toContain("membership=true");
    expect(call?.args[3]).toContain("search=orders%20bff&search_namespaces=true");
    expect(call?.env).toMatchObject({ GITLAB_HOST: "gitlab.example.com", NO_PROMPT: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  test("GitLab fetches one page, and a full page means the search must be narrowed", async () => {
    const { hosting, calls } = fakeHosting({ repos: Array.from({ length: 150 }, (_, i) => gitlabProject(`group/repo-${i}`)) });

    const result = await hosting.repos(GITLAB, "");

    expect(result.repos).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.args[3]).not.toContain("search=");
  });

  test("GitHub fetches pages to the end, skips archived repos and filters by name or description", async () => {
    const repos = [
      ...Array.from({ length: 100 }, (_, i) => githubRepo(`me/other-${i}`)),
      githubRepo("me/trackwall"),
      githubRepo("me/old-trackwall", true),
    ];
    const { hosting, calls } = fakeHosting({ repos });

    const result = await hosting.repos(GITHUB, "TRACKWALL");

    expect(result).toEqual({
      repos: [
        {
          fullName: "me/trackwall",
          description: "description of me/trackwall",
          webUrl: "https://github.com/me/trackwall",
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
      truncated: false,
    });
    expect(calls().map((c) => new URL(c.args[3] ?? "", "https://x/").searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls()[0]?.env).toMatchObject({ GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" });
  });

  test("GitLab gets a query shorter than 3 characters without search, and the daemon matches it itself", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("shop/tw"), gitlabProject("shop/api")] });

    expect((await hosting.repos(GITLAB, "TW")).repos.map((r) => r.fullName)).toEqual(["shop/tw"]);
    expect(calls()[0]?.args[3]).not.toContain("search=");
  });

  test("a later search filtered in the daemon does not ask the repo host again, and a failed question does not stay in memory", async () => {
    const { hosting, calls } = fakeHosting({ repos: [githubRepo("me/trackwall"), githubRepo("me/pawn")] });
    await hosting.repos(GITHUB, "track");
    expect((await hosting.repos(GITHUB, "pawn")).repos.map((r) => r.fullName)).toEqual(["me/pawn"]);
    expect(calls()).toHaveLength(1);

    const failing = fakeHosting({ apiErrors: { "github.com": "gh: no network" } });
    await expect(failing.hosting.repos(GITHUB, "")).rejects.toThrow("no network");
    await expect(failing.hosting.repos(GITHUB, "")).rejects.toThrow("no network");
    expect(failing.calls()).toHaveLength(2);
  });

  test("a name that could be a program option does not get onto the list", async () => {
    const { hosting } = fakeHosting({ repos: [githubRepo("me/-x"), githubRepo("me/ok")] });
    expect((await hosting.repos(GITHUB, "")).repos.map((r) => r.fullName)).toEqual(["me/ok"]);
  });

  test("a glab error comes back with the message from stderr, and a response that does not match the API with a description without a dump", async () => {
    await expect(fakeHosting({ apiErrors: { "gitlab.example.com": "glab: 401 Unauthorized" } }).hosting.repos(GITLAB, "")).rejects.toThrow(
      "401 Unauthorized",
    );
    await expect(fakeHosting({ apiRaw: '{"message":"not a list"}' }).hosting.repos(GITLAB, "")).rejects.toThrow(
      "glab api returned a response that does not match the gitlab.example.com API",
    );
  });

  test("a program missing from PATH is a readable message", async () => {
    const hosting = new Hosting({
      github: { command: "trackwall-no-such-gh", args: [] },
      gitlab: { command: "trackwall-no-such-glab", args: [] },
    });
    await expect(hosting.repos(GITLAB, "")).rejects.toThrow("program trackwall-no-such-glab not found in PATH");
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
