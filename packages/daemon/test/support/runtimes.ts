import pkg from "../../package.json" with { type: "json" };

/**
 * Runtime'y, pod którymi idzie każdy test procesu (ADR-1): Bun i sam Node. Komenda Node pochodzi ze skryptu
 * `start:node`, żeby flagi (`--experimental-strip-types` dla Node 22.12–22.17) były w jednym miejscu.
 */
function nodeArgv(script: string): string[] {
  const suffix = " src/main.ts --ui";
  if (!script.startsWith("node ") || !script.endsWith(suffix))
    throw new Error(`start:node ma postać "node <flagi>${suffix}", jest "${script}"`);
  return script.slice(0, -suffix.length).split(" ");
}

export const RUNTIMES: [name: "bun" | "node", argv: string[]][] = [
  ["bun", ["bun"]],
  ["node", nodeArgv(pkg.scripts["start:node"])],
];
