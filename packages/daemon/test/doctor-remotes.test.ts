import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade } from "../src/facade.ts";
import { remoteFailure, remoteOutcome, shownRemoteError } from "../src/modules/doctor/remote-check.ts";
import { fakeHostingClis } from "./support/hosting.ts";

describe("what git's message says about a remote it could not reach", () => {
  test("ssh without a key, an unknown host key, HTTPS without a sign-in and a host out of reach are told apart", () => {
    expect(remoteFailure("git@gitlab.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe(
      "ssh-key",
    );
    expect(
      remoteFailure(
        "No ED25519 host key is known for gitlab.example.com and you have requested strict checking.\nHost key verification failed.",
      ),
    ).toBe("host-key");
    expect(remoteFailure("fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled")).toBe("sign-in");
    expect(remoteFailure("fatal: Authentication failed for 'https://gitlab.example.com/shop.git/'")).toBe("sign-in");
    expect(
      remoteFailure("fatal: unable to access 'https://gitlab.example.com/shop.git/': Could not resolve host: gitlab.example.com"),
    ).toBe("unreachable");
    expect(remoteFailure("git ls-remote did not finish within 8000 ms")).toBe("unreachable");
    expect(remoteFailure("ssh: connect to host gitlab.example.com port 22: Connection timed out")).toBe("unreachable");
    expect(remoteFailure("fatal: repository 'https://gitlab.example.com/gone.git/' not found")).toBe("other");
  });

  test("the message shown is git's first line that says something, without a token someone put in the address", () => {
    expect(shownRemoteError("git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe(
      "git@host: Permission denied (publickey).",
    );
    expect(shownRemoteError("fatal: unable to access 'https://oauth2:glpat-secret@host/shop.git/': Could not resolve host: host")).toBe(
      "fatal: unable to access 'https://host/shop.git/': Could not resolve host: host",
    );
    expect(shownRemoteError("fatal: unable to access 'https://user:p@ss@host/shop.git/': Failed to connect")).toBe(
      "fatal: unable to access 'https://host/shop.git/': Failed to connect",
    );
    expect(
      shownRemoteError("Warning: Permanently added 'host' to the list of known hosts.\ngit@host: Permission denied (publickey)."),
    ).toBe("git@host: Permission denied (publickey).");
    expect(shownRemoteError("x".repeat(300))).toHaveLength(200);
  });
});

describe("the doctor's row for git access to repo hosts (ADR-195)", () => {
  test("every host reached is ok, and a projects folder without HTTPS or SSH remotes gets no row", () => {
    expect(remoteOutcome([{ host: "gitlab.example.com", repo: "shop", error: null }], true)).toEqual({
      status: "ok",
      summary: "git reaches gitlab.example.com.",
      fix: null,
    });
    expect(remoteOutcome([], true)).toBeNull();
  });

  test("in a container a missing key names the host and the repo, and points to the guide instead of the computer's keys", () => {
    const row = remoteOutcome(
      [
        { host: "gitlab.example.com", repo: "shop", error: "git@gitlab.example.com: Permission denied (publickey)." },
        { host: "github.com", repo: "tools", error: null },
      ],
      true,
    );
    expect(row?.status).toBe("fail");
    expect(row?.summary).toBe(
      "git cannot reach gitlab.example.com (from shop): no SSH key it accepts (git@gitlab.example.com: Permission denied (publickey).). git reaches github.com.",
    );
    expect(row?.fix).toContain('"Git and SSH" in the dev container guide');
  });

  test("on the user's own computer the fix is their own sign-in, and a host out of reach is about the network either way", () => {
    const missing = remoteOutcome([{ host: "gitlab.example.com", repo: "shop", error: "terminal prompts disabled" }], false);
    expect(missing?.fix).toStartWith("Sign in to gitlab.example.com for git");
    const away = remoteOutcome([{ host: "gitlab.example.com", repo: "shop", error: "Could not resolve host: gitlab.example.com" }], true);
    expect(away?.fix).toStartWith("Check the network, VPN and proxy to gitlab.example.com.");
  });
});

/** A repo in the projects folder whose origin is `url`, with more configuration of its own (`key=value`). */
function repoWithOrigin(projects: string, name: string, url: string, config: string[] = []): void {
  const dir = join(projects, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "--quiet", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
  for (const entry of config) {
    const [key = "", ...value] = entry.split("=");
    execFileSync("git", ["-C", dir, "config", key, value.join("=")]);
  }
}

async function facadeOn(projects: string) {
  const facade = createFacade({
    inContainer: true,
    home: mkdtempSync(join(tmpdir(), "trackwall-doctor-remotes-home-")),
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => process.env,
    tlsProbe: async () => ({ kind: "ok" }),
    diskSpace: async () => ({ disk: 1, free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
    log: () => {},
  });
  await facade.workspace.setProjectsDir(projects);
  return facade;
}

describe("the doctor asks real git about the repos' remotes", () => {
  test("a host git cannot connect to fails at once, one repo per host, and a remote that is no HTTPS or SSH address is not checked", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-doctor-remotes-"));
    // Port 1 on loopback refuses at once. `a-plain` comes first by id, but `git://` is nothing to sign in to.
    repoWithOrigin(projects, "a-plain", "git://127.0.0.1:1/plain.git");
    repoWithOrigin(projects, "b-shop", "https://127.0.0.1:1/shop.git");
    repoWithOrigin(projects, "c-billing", "https://127.0.0.1:1/billing.git");
    repoWithOrigin(projects, "d-local", join(tmpdir(), "no-such-bare-repo.git"));
    const facade = await facadeOn(projects);

    expect(await facade.workspace.remoteReach()).toEqual([{ host: "127.0.0.1", repo: "b-shop", error: expect.any(String) }]);
    const row = (await facade.doctor.run()).checks.find((c) => c.id === "git-remotes");
    expect(row?.status).toBe("fail");
    expect(row?.summary).toStartWith("git cannot reach 127.0.0.1 (from b-shop): the host cannot be reached");
  }, 30_000);

  test("at most five hosts are asked, one repo each", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-doctor-remotes-many-"));
    for (const n of [1, 2, 3, 4, 5, 6]) repoWithOrigin(projects, `repo-${n}`, `https://127.0.0.${n}:1/repo.git`);
    const facade = await facadeOn(projects);

    expect((await facade.workspace.remoteReach()).map((r) => r.repo)).toEqual(["repo-1", "repo-2", "repo-3", "repo-4", "repo-5"]);
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "a program a repo's own configuration names is never run by the check, which only the user's sign-in reaches",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-doctor-remotes-config-"));
      const marker = join(projects, "ran");
      repoWithOrigin(projects, "shop", "ssh://git@127.0.0.1:1/shop.git", [
        `core.sshCommand=touch ${marker}; false`,
        `credential.helper=!touch ${marker}`,
      ]);
      const facade = await facadeOn(projects);

      const [read] = await facade.workspace.remoteReach();
      expect(read?.error).toEqual(expect.any(String));
      expect(existsSync(marker)).toBe(false);
    },
    30_000,
  );
});
