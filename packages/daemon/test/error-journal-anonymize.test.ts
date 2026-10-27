import { describe, expect, test } from "bun:test";
import { anonymize, compileKnownValues } from "../src/modules/error-journal/anonymize.ts";

// Every name below is made up: a user, a computer, a company host and a client's repos, as they could appear on a work machine.
const KNOWN = compileKnownValues([
  { value: "C:\\Users\\jan.kowalski\\.trackwall", label: "<trackwall>" },
  { value: "C:\\Users\\jan.kowalski", label: "<home>" },
  { value: "C:\\Users\\jan.kowalski\\Dev", label: "<projects>" },
  { value: "jan.kowalski", label: "<user>" },
  { value: "JAN-PC", label: "<host>" },
  { value: "orders-bff", label: "<repo>", wholeWord: true },
  { value: "api", label: "<repo>", wholeWord: true },
  // An environment variable whose value is a word that is also in a label: it must not break the label.
  { value: "projects", label: "<env>" },
]);
const NONE = compileKnownValues([]);

/** The made-up values none of which may be left in any message. */
const FORBIDDEN = ["jan.kowalski", "JAN-PC", "orders-bff", "example-corp", "Kowalski", "Dev\\", "10.20.30.40", "s3cr3t"];

describe("anonymize", () => {
  test.each([
    [
      "ENOENT: no such file or directory, open 'C:\\Users\\jan.kowalski\\Dev\\orders-bff\\mise.toml'",
      "ENOENT: no such file or directory, open '<path>'",
    ],
    ["failed in C:/Users/jan.kowalski/Dev/orders-bff", "failed in <projects>/…"],
    ['{"path":"C:\\\\Users\\\\jan.kowalski\\\\Dev\\\\x"}', '{"path":"<path>"}'],
    ["cannot write C:\\Users\\jan.kowalski\\.trackwall\\logs\\errors.json", "cannot write <trackwall>\\logs\\errors.json"],
    ["user jan.kowalski on JAN-PC", "user <user> on <host>"],
    ["repo orders-bff has no remote", "repo <repo> has no remote"],
  ])("replaces a known value: %s", (input, expected) => {
    expect(anonymize(input, KNOWN)).toBe(expected);
  });

  test.each([
    ["open 'D:\\work\\Acme Client\\billing-api\\pom.xml' failed", "open '<path>' failed"],
    ["open E:\\Acme Corp\\secret project\\a.ts failed", "open <path> failed"],
    ["open C:\\Users\\jan.kowalski\\Dev\\Acme Client\\billing\\pom.xml", "open <projects>/…"],
    ['open "C:\\Users\\jan.kowalski\\Dev\\Acme Client\\My File.txt"', 'open "<path>"'],
    ["read /workspace/jkowalski/acme/x.ts", "read <path>"],
    ["read C%3A%5CUsers%5Cjkowalski%5Crepo", "read <path>"],
  ])("a path with spaces, between quotes, elsewhere or URL-encoded goes whole: %s", (input, expected) => {
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
    ['{"access_token":"abcdef123456","refreshToken":"x9"}', '{"access_token":"<secret>","refreshToken":"<secret>"}'],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic <secret>"],
    ["clone git@gitlab.acme.co:acme-group/billing.git failed", "clone <url> failed"],
    ["host build01.acme.ai is down", "host <host> is down"],
    ["gh token ghp_abcdefghijklmnopqrstuvwxyz0123", "gh token <secret>"],
    ["sha 0123456789abcdef0123456789abcdef01234567", "sha <secret>"],
  ])("replaces what nobody named: %s", (input, expected) => {
    expect(anonymize(input, NONE)).toBe(expected);
  });

  test("keeps what says where in Trackwall: file names, routes and words in code", () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'branch') in server.ts for POST /api/workspace/sync, this.app";
    expect(anonymize(text, NONE)).toBe(text);
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

  test("a label a shorter value also spells is not broken by it", () => {
    expect(anonymize("in C:\\Users\\jan.kowalski\\Dev and projects", KNOWN)).toBe("in <projects> and <env>");
  });

  test("the rest of a known folder goes with it also when the path is URL-encoded", () => {
    expect(anonymize("GET C%3A%5CUsers%5Cjan.kowalski%5CDev%5Cacme-client%5Cx", KNOWN)).toBe("GET <projects>/…");
  });

  test("a whole-word value that is not a whole word there leaves the values inside it to be found", () => {
    const known = compileKnownValues([
      { value: "jakubpc", label: "<host>", wholeWord: true },
      { value: "pc-secret-value", label: "<env>" },
    ]);
    expect(anonymize("got jakubpc-secret-value", known)).toBe("got jakub<env>");
  });

  test("anonymizing an anonymized message changes nothing, even with a repo named like a label", () => {
    const known = compileKnownValues([
      { value: "C:\\Users\\jan.kowalski", label: "<home>" },
      { value: "home", label: "<repo>", wholeWord: true },
      { value: "path", label: "<repo>", wholeWord: true },
      { value: "projects", label: "<env>" },
    ]);
    for (const input of ["in C:\\Users\\jan.kowalski\\x", "open 'D:\\a\\b' failed", "in <projects> and home"]) {
      const once = anonymize(input, known);
      expect(anonymize(once, known)).toBe(once);
    }
  });

  test.each([
    ["Using basic configuration for repo", "Using basic configuration for repo"],
    ["read ~/acme/app.ts", "read <path>"],
  ])("leaves ordinary words alone and catches a path from home: %s", (input, expected) => {
    expect(anonymize(input, NONE)).toBe(expected);
  });

  test("a huge message is cut before the patterns, so it takes no time", () => {
    const started = performance.now();
    expect(anonymize("a-".repeat(80_000), NONE).length).toBe(500);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a long message is cut to 500 characters", () => {
    expect(anonymize("x ".repeat(400), NONE).length).toBe(500);
  });
});
