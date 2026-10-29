import { describe, expect, test } from "bun:test";
import { networkEnv } from "../src/modules/vcs/git.ts";
import { mainRemote, parseConfig } from "../src/modules/vcs/git-config.ts";
import { remoteAddress } from "../src/modules/vcs/remote.ts";

describe("remote repo address", () => {
  test("SSH, scp and HTTPS to the same repo give the same address, without the user, token, port and .git", () => {
    for (const url of [
      "git@gitlab.example.com:shop/orders/api.git",
      "ssh://git@GitLab.Example.com:2222/shop/orders/api.git",
      "https://gitlab.example.com/shop/orders/api",
      "https://jan:secret-token@gitlab.example.com/shop/orders/api.git/",
      "git+ssh://git@gitlab.example.com/shop/orders/api.git",
    ])
      expect(remoteAddress(url)).toBe("gitlab.example.com/shop/orders/api");
  });

  test("a local path, file:// and a Windows drive letter are not a hosting address", () => {
    for (const url of [
      "/srv/git/api.git",
      "../api",
      "C:\\repo\\api",
      "C:/repo/api",
      "file:///srv/git/api.git",
      "https://gitlab.example.com/",
      "ext::sshpass -p secret ssh git@gitlab.example.com %S 'shop/api'",
      "",
    ])
      expect(remoteAddress(url)).toBeUndefined();
  });

  test("the main remote is origin, and without it the only remote; with several and no origin we do not guess", () => {
    const config = (out: string) => mainRemote(parseConfig(out));
    expect(config("remote.upstream.url\nu\0remote.origin.url\no\0")).toEqual({ name: "origin", url: "o" });
    expect(config("remote.Fork.url\nf\0core.bare\nfalse\0")).toEqual({ name: "Fork", url: "f" });
    expect(config("remote.a.url\na\0remote.b.url\nb\0")).toBeUndefined();
    expect(config("core.bare\nfalse\0core.quotepath\0")).toBeUndefined();
  });

  test("a remote keeps every address, since git pushes to each, and the first is the one it fetches from", () => {
    const config = parseConfig("remote.origin.url\nfirst\0remote.origin.url\nsecond\0");
    expect(config.remotes.get("origin")).toEqual(["first", "second"]);
    expect(mainRemote(config)).toEqual({ name: "origin", url: "first" });
  });

  test("the remote address is after the insteadOf shortcut, with the longest matching prefix, as in git", () => {
    const config = parseConfig(
      "url.git@gitlab.example.com:.insteadof\ngl:\0url.git@other.example.com:shop/.insteadof\ngl:shop/\0remote.origin.url\ngl:shop/api\0",
    );
    expect(mainRemote(config)).toEqual({ name: "origin", url: "git@other.example.com:shop/api" });
  });
});

describe("network commands without prompts", () => {
  test("ssh in batch mode, an empty GIT_ASKPASS and Git Credential Manager without windows", () => {
    expect(networkEnv(undefined, {})).toEqual({
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  test("an ssh program set by the user stays", () => {
    expect(networkEnv(parseConfig("core.sshcommand\nplink -batch\0").sshCommand, {}).GIT_SSH_COMMAND).toBeUndefined();
    expect(networkEnv(undefined, { GIT_SSH: "plink" }).GIT_SSH_COMMAND).toBeUndefined();
    expect(networkEnv(undefined, { GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBeUndefined();
  });
});
