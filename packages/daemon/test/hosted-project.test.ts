import { describe, expect, test } from "bun:test";
import { hostedProject } from "../src/modules/merge-requests/hosted-project.ts";

describe("the repo host of a remote", () => {
  test("GitHub needs no entry in the settings", () => {
    expect(hostedProject("github.com/me/shop", [])).toEqual({ kind: "github", host: "github.com", path: "me/shop" });
  });

  test("a GitLab from the settings matches by host name and keeps its port for the links", () => {
    const hosts = [{ kind: "gitlab", host: "git.example.com:8443" }] as const;

    expect(hostedProject("git.example.com/shop/backend/orders", hosts)).toEqual({
      kind: "gitlab",
      host: "git.example.com:8443",
      path: "shop/backend/orders",
    });
  });

  test("a GitHub Enterprise from the settings is GitHub on that host", () => {
    expect(hostedProject("github.example.com/team/shop", [{ kind: "github", host: "github.example.com" }])).toEqual({
      kind: "github",
      host: "github.example.com",
      path: "team/shop",
    });
  });

  test("another host is unknown, and so is a path no repo host would create", () => {
    expect(hostedProject("git.example.org/shop/orders", [{ kind: "gitlab", host: "gitlab.example.com" }])).toBeNull();
    expect(hostedProject("github.com/me/../shop", [])).toBeNull();
    expect(hostedProject("github.com/shop", [])).toBeNull();
  });
});
