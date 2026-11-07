import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NAMESPACE_SYSCALLS, PROFILE_FILE, sandboxProfile } from "../scripts/sandbox-seccomp.ts";

const profile = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
const COMMIT = "4b8214fc4971e06172938a1f1554ccff6647ee80";

describe("the seccomp profile for Copilot CLI's sandbox in a dev container (ADR-219)", () => {
  test("refuses every system call it does not name, like Docker's default", () => {
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  });

  test("ends with the one rule Trackwall adds: the namespace calls bubblewrap makes, whatever the capabilities", () => {
    expect(profile.syscalls.at(-1)).toEqual({
      names: ["clone", "mount", "pivot_root", "setns", "umount2", "unshare"],
      action: "SCMP_ACT_ALLOW",
      comment: expect.stringMatching(/^Added by Trackwall to seccomp\/default\.json of moby\/profiles at [0-9a-f]{40} \(Apache-2\.0\)/),
    });
    expect([...NAMESPACE_SYSCALLS]).toEqual(profile.syscalls.at(-1).names);
  });

  test("keeps clone3 refused without CAP_SYS_ADMIN, so the C library falls back to the clone the rule allows", () => {
    const clone3 = profile.syscalls.filter((rule: { names: string[] }) => rule.names.includes("clone3"));
    expect(clone3).toContainEqual(expect.objectContaining({ action: "SCMP_ACT_ERRNO", excludes: { caps: ["CAP_SYS_ADMIN"] } }));
  });

  test("is exactly what the script writes from Docker's profile, so generating it again changes nothing", () => {
    expect(sandboxProfile(profile, COMMIT)).toEqual(profile);
  });

  test("the script takes only the full commit of moby/profiles, which the rule's comment names", () => {
    expect(() => sandboxProfile(profile, "main")).toThrow('expected the full commit of moby/profiles, got "main"');
  });
});
