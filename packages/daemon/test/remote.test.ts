import { describe, expect, test } from "bun:test";
import { networkEnv } from "../src/modules/vcs/git.ts";
import { mainRemote, parseConfig } from "../src/modules/vcs/git-config.ts";
import { networkAddress, remoteAddress } from "../src/modules/vcs/remote.ts";

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

  test("tokens, ports and IPv6 hosts in a URL still give the address", () => {
    expect(remoteAddress("https://oauth2:glpat%2Fx@gitlab.example.com:8443/shop/api.git")).toBe("gitlab.example.com/shop/api");
    expect(remoteAddress("ssh://git@[::1]:22/shop/api.git")).toBe("[::1]/shop/api");
  });

  test("an scp address names the host before the first colon, after the last @, where git and ssh connect", () => {
    expect(remoteAddress("evil.example:x@github.com:me/x")).toBe("evil.example/x@github.com:me/x");
    expect(remoteAddress("a@b@evil.example:me/x")).toBe("evil.example/me/x");
    expect(remoteAddress("git@github.com:me/x.git")).toBe("github.com/me/x");
  });

  test("an address git would read differently from the check, is not a hosting address", () => {
    for (const url of [
      // curl connects to evil.example; the WHATWG parser sees github.com and resolves `..` to `/me/x`.
      "https://github.com\\@evil.example/../me/x",
      "https://git%68ub.com/me/x",
      "https://\uff47ithub.com/me/x",
      "https://git\thub.com/me/x",
      "ssh://evil.example?@github.com/me/x",
      "https://github.com/other/x/../../me/x",
      "https://github.com/other/%2e%2e/me/x",
      // git decodes an ssh URL before it takes the host, so ssh connects to evil.example.
      "ssh://evil.example%2F@github.com/me/x",
      "ssh://git@evil.example%2Fx@github.com/me/x",
      "https://a@evil.example@github.com/me/x",
      "[evil.example:x@github.com]:me/x",
      "-oProxyCommand=evil:me/x",
    ])
      expect(remoteAddress(url)).toBeUndefined();
  });

  test("a push address in a form the check could misread never equals the fetch address", () => {
    const fetchesFrom = networkAddress("git@github.com:me/x.git");
    expect(fetchesFrom).toBe("github.com/me/x");
    for (const pushurl of [
      "evil.example:x@github.com:me/x",
      "ssh://evil.example%2F@github.com/me/x",
      "https://github.com\\@evil.example/../me/x",
    ])
      expect(networkAddress(pushurl)).not.toBe(fetchesFrom);
  });

  test("the main remote is origin, and without it the only remote; with several and no origin we do not guess", () => {
    const config = (out: string) => mainRemote(parseConfig(out));
    expect(config("remote.upstream.url\nu\0remote.origin.url\no\0")).toEqual({ name: "origin", url: "o" });
    expect(config("remote.Fork.url\nf\0core.bare\nfalse\0")).toEqual({ name: "Fork", url: "f" });
    expect(config("remote.a.url\na\0remote.b.url\nb\0")).toBeUndefined();
    expect(config("core.bare\nfalse\0core.quotepath\0")).toBeUndefined();
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
