import { type ConsumedHttp, type Evidence, parseHttpUrl } from "@trackwall/protocol";
import { z } from "zod";
import { JSON_KEY } from "./npm.ts";
import { baseName, dirOf, inDir } from "./repo-path.ts";
import { type Extracted, emptyExtracted, keyLines, type RepoSnapshot } from "./snapshot.ts";

/**
 * Adresy backendu we frontendzie (§4.6, ADR-30): zmienne z adresem HTTP w plikach `.env*` obok `package.json`
 * (`VITE_API_URL`, `NEXT_PUBLIC_…`), pole `proxy` w `package.json` (Create React App) i adresy w konfiguracji proxy
 * serwera deweloperskiego (`vite.config.*`, `webpack.config.*`, `vue.config.js`, `next.config.*`, `proxy.conf.*`,
 * `setupProxy.js`). Konfiguracji JS nie wykonuje: adres to napis w cudzysłowie w linii pliku.
 */

const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const PROXY_FILES =
  /^(vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|vue\.config\.[cm]?js|next\.config\.[cm]?[jt]s|proxy\.conf(ig)?\.(json|[cm]?js)|setupProxy\.[jt]s)$/;
/** `KLUCZ=wartość`, z `export` z przodu albo bez. */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=(.*)$/;
/** Adres HTTP w cudzysłowie; klasa znaków bez cudzysłowów i limit długości, bo linia jest z repo. */
const QUOTED_URL = /["'`](https?:\/\/[^"'`\s]{1,500})["'`]/g;
/** Dłuższa linia to wygenerowany kod, nie konfiguracja. */
const MAX_LINE_LENGTH = 2000;
const PackageProxy = z.object({ proxy: z.string() });

/** Pliki, które ten ekstraktor czyta, do wyboru plików z commita (`package.json` czyta też ekstraktor npm). */
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

/** Wartość `.env` bez cudzysłowów i bez komentarza `#` po spacji. */
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
    // Zły JSON zgłasza już ekstraktor npm jako problem karty.
    return [];
  }
  if (!proxy || !parseHttpUrl(proxy)) return [];
  return [client("proxy", "package.json", proxy, { path, line: keyLines(text, JSON_KEY).get("proxy") ?? null })];
}

function client(via: "env" | "proxy", name: string, url: string, evidence: Evidence): ConsumedHttp {
  return { kind: "http", via, name, app: null, url, profiles: [], urlSource: evidence, calls: [], evidence };
}
