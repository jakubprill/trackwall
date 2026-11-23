/**
 * A fake `ssh` for push tests (`core.sshCommand` with `ssh.variant=simple`): git calls it with the host and a command such
 * as `git-receive-pack '/shop/orders.git'`, and it runs that git command on the bare repo under the root directory given
 * as its first argument, so a push to an SSH address on a made-up host lands on disk. With `TRACKWALL_FAKE_SSH_LOG` set,
 * it adds a line per connection to that file, for a test that counts them.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const [root, , command] = process.argv.slice(2);
const match = /^(git-receive-pack|git-upload-pack) '(.+)'$/.exec(command ?? "");
if (!root || !match?.[1] || !match[2]) {
  process.stderr.write(`fake ssh: unexpected ${process.argv.slice(2).join(" ")}\n`);
  process.exit(1);
}
const log = process.env.TRACKWALL_FAKE_SSH_LOG;
if (log) appendFileSync(log, `${match[1]} ${match[2]}\n`);
const result = spawnSync("git", [match[1].replace("git-", ""), join(root, match[2])], { stdio: "inherit" });
process.exit(result.status ?? 1);
