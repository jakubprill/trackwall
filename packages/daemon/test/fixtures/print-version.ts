/** A program whose `--version` prints its first argument, as mise prints its version; anything else fails. */
const [version, ...args] = process.argv.slice(2);
if (args[0] !== "--version" || version === undefined) {
  process.stderr.write(`unexpected arguments: ${args.join(" ")}\n`);
  process.exit(2);
}
process.stdout.write(`${version}\n`);
