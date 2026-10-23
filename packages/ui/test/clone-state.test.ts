import { describe, expect, test } from "bun:test";
import type { CloneJob, RemoteRepo } from "@trackwall/protocol";
import { cloneState, loginCommand } from "../src/lib/clone-state.ts";

const host = { kind: "gitlab", host: "gitlab.example.com" } as const;
const repo: RemoteRepo = {
  fullName: "sklep/api",
  dir: "api",
  description: null,
  webUrl: "https://gitlab.example.com/sklep/api",
  updatedAt: null,
  inProjectsDir: false,
};
const job = (state: CloneJob["state"], message: string | null = null): CloneJob => ({
  host,
  fullName: "sklep/api",
  path: "/projekty/api",
  state,
  message,
});

describe("stan klonu w wierszu repo z hostingu", () => {
  test("repo bez klonowania można sklonować, chyba że jego katalog już jest w folderze", () => {
    expect(cloneState(host, repo, [])).toEqual({ kind: "available" });
    expect(cloneState(host, { ...repo, inProjectsDir: true }, [])).toEqual({ kind: "in-projects-dir" });
  });

  test("ostatnie klonowanie tego repo z tego hostingu wygrywa", () => {
    expect(cloneState(host, repo, [job("failed", "brak dostępu"), job("running")])).toEqual({ kind: "running" });
    expect(cloneState(host, repo, [job("done")])).toEqual({ kind: "done" });
    expect(cloneState(host, repo, [job("failed", "brak dostępu")])).toEqual({ kind: "failed", message: "brak dostępu" });
    expect(cloneState({ kind: "github", host: "github.com" }, repo, [job("running")])).toEqual({ kind: "available" });
  });

  test("komenda logowania dla glab i gh", () => {
    expect(loginCommand(host)).toBe("glab auth login --hostname gitlab.example.com");
    expect(loginCommand({ kind: "github", host: "github.com" })).toBe("gh auth login --hostname github.com");
  });
});
