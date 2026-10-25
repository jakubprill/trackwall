import pkg from "../../package.json" with { type: "json" };

/**
 * The runtimes every process test runs under (ADR-1): Bun and plain Node. The Node command comes from the
 * `start:node` script, so that the flags (`--experimental-strip-types` for Node 22.12–22.17) are in one place.
 */
function nodeArgv(script: string): string[] {
  const suffix = " src/main.ts --ui";
  if (!script.startsWith("node ") || !script.endsWith(suffix))
    throw new Error(`start:node has the form "node <flags>${suffix}", it is "${script}"`);
  return script.slice(0, -suffix.length).split(" ");
}

export const RUNTIMES: [name: "bun" | "node", argv: string[]][] = [
  ["bun", ["bun"]],
  ["node", nodeArgv(pkg.scripts["start:node"])],
];
