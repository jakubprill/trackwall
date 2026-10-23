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
  description: `opis ${fullName}`,
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

describe("hostingi repo przez gh i glab", () => {
  test("GitLab szuka po swojej stronie, w ścieżce z grupą, i podaje glab nazwę hosta", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("sklep/zamowienia/orders-bff")] });

    const result = await hosting.repos(GITLAB, "orders bff");

    expect(result).toEqual({
      repos: [
        {
          fullName: "sklep/zamowienia/orders-bff",
          description: null,
          webUrl: "https://gitlab.example.com/sklep/zamowienia/orders-bff",
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

  test("GitLab pobiera jedną stronę, a pełna strona znaczy, że trzeba zawęzić wyszukiwanie", async () => {
    const { hosting, calls } = fakeHosting({ repos: Array.from({ length: 150 }, (_, i) => gitlabProject(`grupa/repo-${i}`)) });

    const result = await hosting.repos(GITLAB, "");

    expect(result.repos).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.args[3]).not.toContain("search=");
  });

  test("GitHub pobiera kolejne strony do końca, pomija zarchiwizowane i filtruje po nazwie albo opisie", async () => {
    const repos = [
      ...Array.from({ length: 100 }, (_, i) => githubRepo(`ja/inne-${i}`)),
      githubRepo("ja/trackwall"),
      githubRepo("ja/stare-trackwall", true),
    ];
    const { hosting, calls } = fakeHosting({ repos });

    const result = await hosting.repos(GITHUB, "TRACKWALL");

    expect(result).toEqual({
      repos: [
        {
          fullName: "ja/trackwall",
          description: "opis ja/trackwall",
          webUrl: "https://github.com/ja/trackwall",
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
      truncated: false,
    });
    expect(calls().map((c) => new URL(c.args[3] ?? "", "https://x/").searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls()[0]?.env).toMatchObject({ GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" });
  });

  test("zapytanie krótsze niż 3 znaki GitLab dostaje bez wyszukiwania, a daemon dopasowuje je sam", async () => {
    const { hosting, calls } = fakeHosting({ repos: [gitlabProject("sklep/tw"), gitlabProject("sklep/api")] });

    expect((await hosting.repos(GITLAB, "TW")).repos.map((r) => r.fullName)).toEqual(["sklep/tw"]);
    expect(calls()[0]?.args[3]).not.toContain("search=");
  });

  test("kolejne wyszukiwanie filtrowane w daemonie nie pyta hostingu drugi raz, a nieudane pytanie nie zostaje w pamięci", async () => {
    const { hosting, calls } = fakeHosting({ repos: [githubRepo("ja/trackwall"), githubRepo("ja/pawn")] });
    await hosting.repos(GITHUB, "track");
    expect((await hosting.repos(GITHUB, "pawn")).repos.map((r) => r.fullName)).toEqual(["ja/pawn"]);
    expect(calls()).toHaveLength(1);

    const failing = fakeHosting({ apiErrors: { "github.com": "gh: brak sieci" } });
    await expect(failing.hosting.repos(GITHUB, "")).rejects.toThrow("brak sieci");
    await expect(failing.hosting.repos(GITHUB, "")).rejects.toThrow("brak sieci");
    expect(failing.calls()).toHaveLength(2);
  });

  test("nazwa, która mogłaby być opcją programu, nie trafia na listę", async () => {
    const { hosting } = fakeHosting({ repos: [githubRepo("ja/-x"), githubRepo("ja/ok")] });
    expect((await hosting.repos(GITHUB, "")).repos.map((r) => r.fullName)).toEqual(["ja/ok"]);
  });

  test("błąd glab wraca z komunikatem z stderr, a odpowiedź niezgodna z API z opisem bez zrzutu", async () => {
    await expect(fakeHosting({ apiErrors: { "gitlab.example.com": "glab: 401 Unauthorized" } }).hosting.repos(GITLAB, "")).rejects.toThrow(
      "401 Unauthorized",
    );
    await expect(fakeHosting({ apiRaw: '{"message":"nie lista"}' }).hosting.repos(GITLAB, "")).rejects.toThrow(
      "glab api zwrócił odpowiedź niezgodną z API gitlab.example.com",
    );
  });

  test("brak programu w PATH to czytelny komunikat", async () => {
    const hosting = new Hosting({
      github: { command: "trackwall-nie-ma-takiego-gh", args: [] },
      gitlab: { command: "trackwall-nie-ma-takiego-glab", args: [] },
    });
    await expect(hosting.repos(GITLAB, "")).rejects.toThrow("nie znaleziono programu trackwall-nie-ma-takiego-glab w PATH");
  });

  test("klon woła repo clone z pełną nazwą i katalogiem, bez odziedziczonego GIT_DIR", async () => {
    const { hosting, calls } = fakeHosting();
    const dest = join(mkdtempSync(join(tmpdir(), "trackwall-klon-")), "orders-bff");
    process.env.GIT_DIR = "/gdzies/indziej";
    try {
      await hosting.clone(GITLAB, "sklep/orders-bff", dest);
    } finally {
      delete process.env.GIT_DIR;
    }

    expect(calls()).toEqual([
      {
        args: ["repo", "clone", "sklep/orders-bff", dest],
        env: { GITLAB_HOST: "gitlab.example.com", NO_PROMPT: "1", GIT_TERMINAL_PROMPT: "0" },
      },
    ]);
  });
});
