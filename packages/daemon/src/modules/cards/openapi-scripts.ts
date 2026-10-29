import { type ConsumedHttp, parseHttpUrl } from "@trackwall/protocol";
import { z } from "zod";
import { JSON_KEY } from "./npm.ts";
import { baseName } from "./repo-path.ts";
import { type Extracted, emptyExtracted, keyLines, type RepoSnapshot } from "./snapshot.ts";

/**
 * Specs a frontend downloads to generate its client (§4.6, ADR-129): a `package.json` script running `openapi-typescript`
 * on an address (`openapi-typescript http://localhost:8090/v3/api-docs -o src/api/orders.ts`). Such a spec is not in the
 * repo, so its operations are unknown, but the address names the app that serves it: the host, or the port on
 * `localhost`. The client has the address's origin, since its path is where the app serves its spec, not its API. A
 * script that reads a spec file from the repo adds nothing: that file is a client already (`openapi-clients.ts`).
 */

const PackageScripts = z.object({ scripts: z.record(z.string(), z.string()) });
/** The generator's command, also run through `npx` or with a version (`openapi-typescript@7`). */
const GENERATOR = /(^|\/)openapi-typescript(@[\w.-]+)?$/;
const OUTPUT_OPTIONS = new Set(["-o", "--output"]);
/** A longer script is not one a person wrote. */
const MAX_SCRIPT_LENGTH = 2000;

export function readsOpenApiScriptFile(path: string): boolean {
  return baseName(path) === "package.json";
}

export function extractOpenApiScripts(snapshot: RepoSnapshot): Extracted<never, ConsumedHttp> {
  const out: Extracted<never, ConsumedHttp> = emptyExtracted();
  for (const path of snapshot.paths.filter(readsOpenApiScriptFile)) out.consumes.push(...scriptClients(path, snapshot.text(path)));
  return out;
}

function scriptClients(path: string, text: string | undefined): ConsumedHttp[] {
  const scripts = text === undefined ? undefined : scriptsOf(text);
  if (text === undefined || scripts === undefined) return [];
  const line = scriptLines(text);
  return Object.entries(scripts).flatMap(([name, script]) =>
    downloadedSpecs(script).map(
      (url): ConsumedHttp => ({
        kind: "http",
        via: "openapi",
        name,
        app: null,
        url,
        profiles: [],
        urlSource: null,
        calls: [],
        evidence: { path, line: line(name) },
      }),
    ),
  );
}

/** The line of a script's name, looked for after the `scripts` key: a script called like a dependency must not take its line. */
function scriptLines(text: string): (name: string) => number | null {
  const from = keyLines(text, JSON_KEY).get("scripts") ?? 1;
  const lines = keyLines(text.split("\n").slice(from).join("\n"), JSON_KEY);
  return (name) => {
    const line = lines.get(name);
    return line === undefined ? null : from + line;
  };
}

function scriptsOf(text: string): Record<string, string> | undefined {
  try {
    return PackageScripts.safeParse(JSON.parse(text)).data?.scripts;
  } catch {
    // The npm extractor already reports bad JSON as a card problem.
    return undefined;
  }
}

/**
 * The origins of the addresses `openapi-typescript` reads in a script: its first argument that is neither an option nor
 * the value of `-o`/`--output`. Another option with a separate value in front of the input hides the input (§8).
 */
function downloadedSpecs(script: string): string[] {
  if (script.length > MAX_SCRIPT_LENGTH) return [];
  const words = script.split(/\s+/);
  return words.flatMap((word, i) => {
    if (!GENERATOR.test(word)) return [];
    const input = words.slice(i + 1).find((w, j, rest) => !w.startsWith("-") && !OUTPUT_OPTIONS.has(rest[j - 1] ?? ""));
    const url = input === undefined ? undefined : parseHttpUrl(input.replace(/^["']|["']$/g, ""));
    if (url === undefined || url.scheme === "lb") return [];
    // Only the origin: a user and password in front of the host do not reach the card.
    return [`${url.scheme}://${url.host}${url.port === null ? "" : `:${url.port}`}`];
  });
}
