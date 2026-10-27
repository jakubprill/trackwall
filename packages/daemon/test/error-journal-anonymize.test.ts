import { describe, expect, test } from "bun:test";
import { anonymize, type KnownValue } from "../src/modules/error-journal/anonymize.ts";

// Every name below is made up: a user, a computer, a company host and a client's repos, as they could appear on a work machine.
const KNOWN: KnownValue[] = [
  { value: "C:\\Users\\jan.kowalski\\.trackwall", label: "<trackwall>" },
  { value: "C:\\Users\\jan.kowalski", label: "<home>" },
  { value: "C:\\Users\\jan.kowalski\\Dev", label: "<projects>" },
  { value: "jan.kowalski", label: "<user>" },
  { value: "JAN-PC", label: "<host>" },
  { value: "orders-bff", label: "<repo>", wholeWord: true },
  { value: "api", label: "<repo>", wholeWord: true },
];

/** The made-up values none of which may be left in any message. */
const FORBIDDEN = ["jan.kowalski", "JAN-PC", "orders-bff", "example-corp", "Kowalski", "Dev\\", "10.20.30.40", "s3cr3t"];

describe("anonymize", () => {
  test.each([
    [
      "ENOENT: no such file or directory, open 'C:\\Users\\jan.kowalski\\Dev\\orders-bff\\mise.toml'",
      "ENOENT: no such file or directory, open '<projects>/…'",
    ],
    ["failed in C:/Users/jan.kowalski/Dev/orders-bff", "failed in <projects>/…"],
    ['{"path":"C:\\\\Users\\\\jan.kowalski\\\\Dev\\\\x"}', '{"path":"<projects>/…"}'],
    ["cannot write C:\\Users\\jan.kowalski\\.trackwall\\logs\\errors.json", "cannot write <trackwall>\\logs\\errors.json"],
    ["user jan.kowalski on JAN-PC", "user <user> on <host>"],
    ["repo orders-bff has no remote", "repo <repo> has no remote"],
  ])("replaces a known value: %s", (input, expected) => {
    expect(anonymize(input, KNOWN)).toBe(expected);
  });

  test("a repo name is replaced only as a whole word, so API routes keep their words", () => {
    expect(anonymize("POST /api/workspace/sync failed for api", KNOWN)).toBe("POST /api/workspace/sync failed for <repo>");
  });

  test.each([
    ["getaddrinfo ENOTFOUND git.example-corp.internal", "getaddrinfo ENOTFOUND <host>"],
    ["fetch https://git.example-corp.com/team/orders.git failed", "fetch <url> failed"],
    ["connect ECONNREFUSED 10.20.30.40:443", "connect ECONNREFUSED <ip>:443"],
    ["connect ECONNREFUSED 127.0.0.1:51234", "connect ECONNREFUSED 127.0.0.1:51234"],
    ["mail jan.kowalski@example-corp.com", "mail <email>"],
    ["open D:\\Work\\Client\\secret.txt", "open <path>"],
    ["open \\\\fileserver\\share\\plan.docx", "open <path>"],
    ["read /Users/anna/Projects/x and /home/anna/y", "read <path> and <path>"],
    ["Authorization: Bearer abc.def.ghi", "Authorization: Bearer <secret>"],
    ["url?token=s3cr3t&x=1", "url?token=<secret>&x=1"],
    ["password: s3cr3t", "password: <secret>"],
    ["gh token ghp_abcdefghijklmnopqrstuvwxyz0123", "gh token <secret>"],
    ["sha 0123456789abcdef0123456789abcdef01234567", "sha <secret>"],
  ])("replaces what nobody named: %s", (input, expected) => {
    expect(anonymize(input, [])).toBe(expected);
  });

  test("keeps what says where in Trackwall: file names, routes and words in code", () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'branch') in server.ts for POST /api/workspace/sync, this.app";
    expect(anonymize(text, [])).toBe(text);
  });

  test("a message made of every kind of value keeps none of them", () => {
    const message = [
      "C:\\Users\\jan.kowalski\\Dev\\orders-bff\\src",
      "JAN-PC",
      "https://git.example-corp.internal/a",
      "git.example-corp.internal",
      "10.20.30.40",
      "token=s3cr3t",
      "D:\\Kowalski\\notes",
    ].join(" ");
    const out = anonymize(message, KNOWN);
    for (const value of FORBIDDEN) expect(out).not.toContain(value);
  });

  test("a long message is cut to 500 characters", () => {
    expect(anonymize("x ".repeat(400), []).length).toBe(500);
  });
});
