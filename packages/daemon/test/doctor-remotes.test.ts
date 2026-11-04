import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
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
    expect(remoteFailure("fatal: repository 'https://gitlab.example.com/gone.git/' not found")).toBe("other");
  });

  test("the message shown is git's first line that says something, without a token someone put in the address", () => {
    expect(shownRemoteError("git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe(
      "git@host: Permission denied (publickey).",
    );
    expect(shownRemoteError("fatal: unable to access 'https://oauth2:glpat-secret@host/shop.git/': Could not resolve host: host")).toBe(
      "fatal: unable to access 'https://host/shop.git/': Could not resolve host: host",
    );
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

/** A repo in the projects folder whose origin is `url`. */
function repoWithOrigin(projects: string, name: string, url: string): void {
  const dir = join(projects, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "--quiet", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
}

describe("the doctor asks real git about the repos' remotes", () => {
  test("a host git cannot connect to fails at once, one repo per host, and a remote in a local folder is not checked", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-doctor-remotes-"));
    // Port 1 on loopback refuses at once, over HTTPS and over SSH alike.
    repoWithOrigin(projects, "a-shop", "https://127.0.0.1:1/shop.git");
    repoWithOrigin(projects, "b-billing", "https://127.0.0.1:1/billing.git");
    repoWithOrigin(projects, "c-local", join(tmpdir(), "no-such-bare-repo.git"));
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

    expect(await facade.workspace.remoteReach()).toEqual([{ host: "127.0.0.1", repo: "a-shop", error: expect.any(String) }]);
    const row = (await facade.doctor.run()).checks.find((c) => c.id === "git-remotes");
    expect(row?.status).toBe("fail");
    expect(row?.summary).toStartWith("git cannot reach 127.0.0.1 (from a-shop): the host cannot be reached");
  }, 30_000);
});
