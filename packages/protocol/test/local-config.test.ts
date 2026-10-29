import { describe, expect, test } from "bun:test";
import { withoutUserInfo } from "../src/local-config.ts";

describe("a remote's address as Trackwall shows it", () => {
  test("an HTTPS address loses its user and token, even a token with an @ in it", () => {
    expect(withoutUserInfo("https://me:secret@git.example.com/me/store.git")).toBe("https://git.example.com/me/store.git");
    expect(withoutUserInfo("https://oauth2:to@ken@git.example.com/me/store.git")).toBe("https://git.example.com/me/store.git");
    expect(withoutUserInfo("http://token@git.example.com/me/store.git")).toBe("http://git.example.com/me/store.git");
  });

  test("an SSH address and an address without a user stay as they are", () => {
    expect(withoutUserInfo("ssh://git@git.example.com/me/store.git")).toBe("ssh://git@git.example.com/me/store.git");
    expect(withoutUserInfo("git@git.example.com:me/store.git")).toBe("git@git.example.com:me/store.git");
    expect(withoutUserInfo("https://git.example.com/me/a@b.git")).toBe("https://git.example.com/me/a@b.git");
  });
});
