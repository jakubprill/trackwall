/**
 * Writes the seccomp profile that lets Copilot CLI's sandbox run in a dev container (ADR-219, the dev container guide):
 * Docker's default profile from moby/profiles, unchanged, plus one rule that allows the system calls bubblewrap makes
 * its namespaces with. Docker's default allows them only with `CAP_SYS_ADMIN`, which a dev container does not have, so
 * the sandbox refused every command there. In a user namespace those calls reach only what that namespace owns.
 *
 *   bun apps/docs/scripts/sandbox-seccomp.ts <moby/profiles>/seccomp/default.json <commit of moby/profiles>
 *
 * moby/profiles is Apache-2.0 licensed; the added rule's comment names the source and its commit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where the documentation site serves the profile from, for the guide's download link. */
export const PROFILE_FILE = fileURLToPath(new URL("../public/dev-container/sandbox-seccomp.json", import.meta.url));

/**
 * What bubblewrap needs and Docker's default allows only with `CAP_SYS_ADMIN`: new namespaces (`clone`, `unshare`),
 * joining them (`setns`, for slirp4netns), and the mounts of the sandbox's own root (`mount`, `umount2`, `pivot_root`).
 * `clone3` stays refused with ENOSYS, as in Docker's default, so the C library falls back to `clone`.
 */
export const NAMESPACE_SYSCALLS = ["clone", "mount", "pivot_root", "setns", "umount2", "unshare"] as const;

/** How the added rule is told from Docker's own, also when the profile is generated again. */
const RULE_MARK = "Added by Trackwall";

const Rule = z.looseObject({ names: z.array(z.string()), action: z.string(), comment: z.string().optional() });
const Profile = z.looseObject({ defaultAction: z.string(), syscalls: z.array(Rule) });
type Profile = z.infer<typeof Profile>;

/** Docker's profile `moby` with the rule for the sandbox's namespaces at the end, replacing an earlier one. */
export function sandboxProfile(moby: unknown, commit: string): Profile {
  const profile = Profile.parse(moby);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`expected the full commit of moby/profiles, got "${commit}"`);
  const own = profile.syscalls.filter((rule) => !rule.comment?.startsWith(RULE_MARK));
  const rule = {
    names: [...NAMESPACE_SYSCALLS],
    action: "SCMP_ACT_ALLOW",
    comment: `${RULE_MARK} to seccomp/default.json of moby/profiles at ${commit} (Apache-2.0), so that Copilot CLI's sandbox (bubblewrap) can make its namespaces without CAP_SYS_ADMIN.`,
  };
  return { ...profile, syscalls: [...own, rule] };
}

if (import.meta.main) {
  const [source, commit] = process.argv.slice(2);
  if (source === undefined || commit === undefined)
    throw new Error("usage: bun apps/docs/scripts/sandbox-seccomp.ts <seccomp/default.json> <commit>");
  const profile = sandboxProfile(JSON.parse(readFileSync(source, "utf8")), commit);
  writeFileSync(PROFILE_FILE, `${JSON.stringify(profile, null, 2)}\n`);
  process.stdout.write(`${PROFILE_FILE}\n`);
}
