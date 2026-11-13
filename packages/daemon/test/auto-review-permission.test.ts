import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPermission } from "../src/modules/agents/auto-review-permission.ts";

// The daemon's answer to the automatic reviewer's approvals (ADR-182, clarification of 2026-11-13): a read of the
// review's own folder once, everything else refused. The requests have the shape Copilot CLI 1.0.110 sends over ACP
// (`contract/auto-review.contract.ts`).

const root = mkdtempSync(join(tmpdir(), "trackwall-review-permission-"));
const reviewDir = join(root, "auto-reviews", "rules", "task-1");
const diff = join(reviewDir, "changes.diff");
const rule = join(reviewDir, "rules", "AGENTS.md");
const outside = join(root, "outside");
const secret = join(outside, "secret.txt");
mkdirSync(join(reviewDir, "rules"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(diff, "+export const total = 1;\n");
writeFileSync(rule, "- Never export a constant named `total`.\n");
writeFileSync(secret, "secret\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const OPTIONS = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject_once", kind: "reject_once", name: "Deny" },
];

function readRequest(...paths: string[]) {
  return {
    sessionId: "s1",
    toolCall: {
      toolCallId: "call_3_0",
      title: "Access paths outside trusted directories",
      kind: "read",
      status: "pending",
      rawInput: { path: paths[0] },
      locations: paths.map((path) => ({ path })),
    },
    options: OPTIONS,
  };
}

const APPROVED = { outcome: "selected", optionId: "allow_once" } as const;
const REFUSED = { outcome: "selected", optionId: "reject_once" } as const;

describe("the automatic reviewer's approvals (ADR-182)", () => {
  test("reading the diff or a rule file's copy in the review's folder is approved once, never always", () => {
    expect(reviewPermission("session/request_permission", readRequest(diff), reviewDir)).toEqual({
      title: `Access paths outside trusted directories: ${diff}`,
      outcome: APPROVED,
      approved: true,
    });
    expect(reviewPermission("session/request_permission", readRequest(rule), reviewDir).outcome).toEqual(APPROVED);
    expect(reviewPermission("session/request_permission", readRequest(reviewDir), reviewDir).outcome).toEqual(APPROVED);
  });

  test("reading anything outside the review's folder is refused and named with its path", () => {
    expect(reviewPermission("session/request_permission", readRequest(secret), reviewDir)).toEqual({
      title: `Access paths outside trusted directories: ${secret}`,
      outcome: REFUSED,
      approved: false,
    });
    // The folder of another review, and the state directory above it.
    expect(reviewPermission("session/request_permission", readRequest(join(root, "auto-reviews")), reviewDir).approved).toBe(false);
  });

  test("a path that climbs out with .. or names the folder only in part is refused", () => {
    expect(
      reviewPermission("session/request_permission", readRequest(join(reviewDir, "..", "..", "..", "outside", "secret.txt")), reviewDir)
        .approved,
    ).toBe(false);
    expect(reviewPermission("session/request_permission", readRequest(`${reviewDir}-other`), reviewDir).approved).toBe(false);
    expect(reviewPermission("session/request_permission", readRequest("rules/AGENTS.md"), reviewDir).approved).toBe(false);
  });

  test("a link in the review's folder that leads out of it is refused", () => {
    const link = join(reviewDir, "escape");
    // A junction on Windows, which needs no administrator; a symbolic link elsewhere.
    symlinkSync(outside, link, "junction");

    expect(reviewPermission("session/request_permission", readRequest(join(link, "secret.txt")), reviewDir).approved).toBe(false);
  });

  test("a read that names one path inside and one outside is refused as a whole", () => {
    expect(reviewPermission("session/request_permission", readRequest(diff, secret), reviewDir).approved).toBe(false);
  });

  test("a path that does not exist is refused, since nothing the daemon wrote is there", () => {
    expect(reviewPermission("session/request_permission", readRequest(join(reviewDir, "missing.diff")), reviewDir).approved).toBe(false);
  });

  test("a tool that is not a read is refused even on the review's folder", () => {
    const request = readRequest(diff);
    request.toolCall.kind = "edit";
    request.toolCall.title = "Edit file";

    expect(reviewPermission("session/request_permission", request, reviewDir)).toEqual({
      title: `Edit file: ${diff}`,
      outcome: REFUSED,
      approved: false,
    });
  });

  test("without an option to allow once, a read of the review's folder is refused", () => {
    const request = { ...readRequest(diff), options: OPTIONS.filter((option) => option.kind !== "allow_once") };

    expect(reviewPermission("session/request_permission", request, reviewDir)).toMatchObject({ outcome: REFUSED, approved: false });
  });

  test("a request the daemon cannot read is cancelled, and any other method is not offered", () => {
    expect(reviewPermission("session/request_permission", { sessionId: "s1" }, reviewDir)).toEqual({
      title: "an approval it could not read",
      outcome: { outcome: "cancelled" },
      approved: false,
    });
    expect(() => reviewPermission("fs/read_text_file", readRequest(diff), reviewDir)).toThrow("fs/read_text_file is not offered");
  });
});
