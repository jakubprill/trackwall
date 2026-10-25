import { type ConsumedHttp, type Evidence, parseHttpUrl, withoutCredentials } from "@trackwall/protocol";
import { z } from "zod";
import { JSON_KEY } from "./npm.ts";
import { baseName, dirOf, inDir } from "./repo-path.ts";
import { type Extracted, emptyExtracted, keyLines, type RepoSnapshot } from "./snapshot.ts";

/**
 * Backend addresses in a frontend (§4.6, ADR-30): variables with an HTTP address in `.env*` files next to `package.json`
 * (`VITE_API_URL`, `NEXT_PUBLIC_…`), the `proxy` field in `package.json` (Create React App) and addresses in the dev
 * server's proxy configuration (`vite.config.*`, `webpack.config.*`, `vue.config.js`, `next.config.*`, `proxy.conf.*`,
 * `setupProxy.js`). It does not run JS configuration: an address is a quoted string on a line of the file.
 */

const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const PROXY_FILES =
  /^(vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|vue\.config\.[cm]?js|next\.config\.[cm]?[jt]s|proxy\.conf(ig)?\.(json|[cm]?js)|setupProxy\.[jt]s)$/;
/** `KEY=value`, with or without `export` in front. */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=(.*)$/;
/** A quoted HTTP address; a character class without quotes and a length limit, because the line comes from the repo. */
const QUOTED_URL = /["'`](https?:\/\/[^"'`\s]{1,500})["'`]/g;
/** A longer line is generated code, not configuration. */
const MAX_LINE_LENGTH = 2000;
const PackageProxy = z.object({ proxy: z.string() });

/** The files this extractor reads, for choosing files from the commit (`package.json` is also read by the npm extractor). */
export function readsFrontendHttpFile(path: string): boolean {
  const name = baseName(path);
  return ENV_FILE.test(name) || PROXY_FILES.test(name);
}

export function extractFrontendHttp(snapshot: RepoSnapshot): Extracted<never, ConsumedHttp> {
  const out: Extracted<never, ConsumedHttp> = emptyExtracted();
  const packageDirs = new Set(snapshot.paths.filter((p) => baseName(p) === "package.json").map(dirOf));
  for (const path of snapshot.paths) {
    if (!packageDirs.has(dirOf(path)) && !PROXY_FILES.test(baseName(path))) continue;
    const text = snapshot.text(path);
    if (text === undefined) continue;
    if (ENV_FILE.test(baseName(path))) out.consumes.push(...envClients(path, text));
    else if (PROXY_FILES.test(baseName(path))) out.consumes.push(...proxyClients(path, text));
  }
  for (const dir of packageDirs) out.consumes.push(...packageProxy(snapshot, inDir(dir, "package.json")));
  return out;
}

function envClients(path: string, text: string): ConsumedHttp[] {
  return text.split("\n").flatMap((line, i) => {
    const m = line.length > MAX_LINE_LENGTH ? null : ENV_LINE.exec(line);
    const value = m?.[2] ? unquote(m[2]) : "";
    return m?.[1] && parseHttpUrl(value) ? [client("env", m[1], value, { path, line: i + 1 })] : [];
  });
}

/** A `.env` value without quotes and without a `#` comment after a space. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) return value.slice(1, value.indexOf(quote, 1));
  return (value.split(" #")[0] ?? "").trim();
}

function proxyClients(path: string, text: string): ConsumedHttp[] {
  const found: ConsumedHttp[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.length > MAX_LINE_LENGTH) return;
    for (const m of line.matchAll(QUOTED_URL)) if (m[1]) found.push(client("proxy", baseName(path), m[1], { path, line: i + 1 }));
  });
  return found;
}

function packageProxy(snapshot: RepoSnapshot, path: string): ConsumedHttp[] {
  const text = snapshot.text(path);
  if (text === undefined) return [];
  let proxy: string | undefined;
  try {
    proxy = PackageProxy.safeParse(JSON.parse(text)).data?.proxy;
  } catch {
    // The npm extractor already reports bad JSON as a card problem.
    return [];
  }
  if (!proxy || !parseHttpUrl(proxy)) return [];
  return [client("proxy", "package.json", proxy, { path, line: keyLines(text, JSON_KEY).get("proxy") ?? null })];
}

function client(via: "env" | "proxy", name: string, url: string, evidence: Evidence): ConsumedHttp {
  return { kind: "http", via, name, app: null, url: withoutCredentials(url), profiles: [], urlSource: evidence, calls: [], evidence };
}
