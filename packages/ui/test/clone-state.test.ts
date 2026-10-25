import { describe, expect, test } from "bun:test";
import type { CloneJob, RemoteRepo } from "@trackwall/protocol";
import { cloneState } from "../src/lib/clone-state.ts";
import { loginCommand } from "../src/lib/repo-hosts.ts";

const host = { kind: "gitlab", host: "gitlab.example.com" } as const;
const repo: RemoteRepo = {
  fullName: "shop/api",
  dir: "api",
  description: null,
  webUrl: "https://gitlab.example.com/shop/api",
  updatedAt: null,
  inProjectsDir: false,
};
const target = { host, fullName: "shop/api", path: "/projects/api" };
const job = (state: "running" | "done"): CloneJob => ({ ...target, state });
const failed = (message: string): CloneJob => ({ ...target, state: "failed", message });

describe("clone state in a repo host row", () => {
  test("a repo that is not being cloned can be cloned, unless its directory is already in the folder", () => {
    expect(cloneState(host, repo, [])).toEqual({ kind: "available" });
    expect(cloneState(host, { ...repo, inProjectsDir: true }, [])).toEqual({ kind: "in-projects-dir" });
  });

  test("the latest clone of this repo from this repo host wins", () => {
    expect(cloneState(host, repo, [failed("access denied"), job("running")])).toEqual({ kind: "running" });
    expect(cloneState(host, repo, [job("done")])).toEqual({ kind: "done" });
    expect(cloneState(host, repo, [failed("access denied")])).toEqual({ kind: "failed", message: "access denied" });
    expect(cloneState({ kind: "github", host: "github.com" }, repo, [job("running")])).toEqual({ kind: "available" });
  });

  test("the login command names the repo host's program and the host name", () => {
    expect(loginCommand(host)).toBe("glab auth login --hostname gitlab.example.com");
    expect(loginCommand({ kind: "github", host: "github.com" })).toBe("gh auth login --hostname github.com");
  });
});
