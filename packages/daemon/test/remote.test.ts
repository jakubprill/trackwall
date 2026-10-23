import { describe, expect, test } from "bun:test";
import { mainRemote, parseConfig, remoteAddress } from "../src/modules/vcs/remote.ts";
import { noPromptEnv } from "../src/modules/vcs/sync.ts";

describe("adres repo zdalnego", () => {
  test("SSH, scp i HTTPS do tego samego repo dają ten sam adres, bez użytkownika, tokenu, portu i .git", () => {
    for (const url of [
      "git@gitlab.example.com:sklep/zamowienia/api.git",
      "ssh://git@GitLab.Example.com:2222/sklep/zamowienia/api.git",
      "https://gitlab.example.com/sklep/zamowienia/api",
      "https://jan:tajny-token@gitlab.example.com/sklep/zamowienia/api.git/",
      "git+ssh://git@gitlab.example.com/sklep/zamowienia/api.git",
    ])
      expect(remoteAddress(url)).toBe("gitlab.example.com/sklep/zamowienia/api");
  });

  test("ścieżka lokalna, file:// i litera dysku Windowsa nie są adresem hostingu", () => {
    for (const url of [
      "/srv/git/api.git",
      "../api",
      "C:\\repo\\api",
      "C:/repo/api",
      "file:///srv/git/api.git",
      "https://gitlab.example.com/",
      "",
    ])
      expect(remoteAddress(url)).toBeUndefined();
  });

  test("główny remote to origin, a bez niego jedyny remote; kilku bez origin nie zgadujemy", () => {
    const config = (out: string) => mainRemote(parseConfig(out));
    expect(config("remote.upstream.url\nu\0remote.origin.url\no\0")).toEqual({ name: "origin", url: "o" });
    expect(config("remote.Fork.url\nf\0core.bare\nfalse\0")).toEqual({ name: "Fork", url: "f" });
    expect(config("remote.a.url\na\0remote.b.url\nb\0")).toBeUndefined();
    expect(config("core.bare\nfalse\0core.quotepath\0")).toBeUndefined();
  });
});

describe("komendy sieciowe bez pytań", () => {
  test("ssh w trybie wsadowym, pusty GIT_ASKPASS i Git Credential Manager bez okien", () => {
    expect(noPromptEnv(parseConfig(""), {})).toEqual({
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  test("program ssh ustawiony przez użytkownika zostaje", () => {
    expect(noPromptEnv(parseConfig("core.sshcommand\nplink -batch\0"), {}).GIT_SSH_COMMAND).toBeUndefined();
    expect(noPromptEnv(parseConfig(""), { GIT_SSH: "plink" }).GIT_SSH_COMMAND).toBeUndefined();
    expect(noPromptEnv(parseConfig(""), { GIT_SSH_COMMAND: "ssh -i klucz" }).GIT_SSH_COMMAND).toBeUndefined();
  });
});
