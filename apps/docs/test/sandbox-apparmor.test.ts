import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const profile = readFileSync(fileURLToPath(new URL("../public/dev-container/trackwall-sandbox.apparmor.txt", import.meta.url)), "utf8");
const rules = profile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

describe("the AppArmor profile for Copilot CLI's sandbox in a dev container on Colima (ADR-219)", () => {
  test("is named trackwall-sandbox, the name the guide's runArgs select", () => {
    expect(rules).toContain("profile trackwall-sandbox flags=(attach_disconnected,mediate_deleted) {");
  });

  test("adds to Docker's profile only the user namespaces and mounts bubblewrap makes", () => {
    expect(rules).toContain("userns,");
    expect(rules).toContain("mount,");
    expect(rules).toContain("pivot_root,");
    expect(rules).not.toContain("deny mount,");
  });

  test("keeps Docker's denies, so root in the container still cannot write /proc/sys or reach sysrq and the kernel's memory", () => {
    expect(rules).toContain("deny @{PROC}/sys/[^k]** w,");
    expect(rules).toContain("deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,");
    expect(rules).toContain("deny @{PROC}/sysrq-trigger rwklx,");
    expect(rules).toContain("deny @{PROC}/kcore rwklx,");
    expect(rules).toContain("deny /sys/kernel/security/** rwklx,");
  });
});
