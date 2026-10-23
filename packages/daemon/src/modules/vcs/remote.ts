/**
 * Adres repo zdalnego (ADR-21): identyfikator repo niezależny od nazwy katalogu i protokołu klonu. Czysta funkcja,
 * testowana bez procesu.
 */

const NETWORK_SCHEMES = new Set(["ssh:", "git:", "http:", "https:", "git+ssh:", "ssh+git:"]);

/**
 * Adres repo zdalnego jako `host/ścieżka`: bez schematu, użytkownika (z hasłem albo tokenem, jeśli ktoś je wpisał
 * w URL), portu i końcówki `.git`, z hostem małymi literami. `git@host:grupa/repo.git` i
 * `https://host/grupa/repo` dają to samo. Ścieżka lokalna, `file://` i `transport::` dają `undefined`: nie mówią
 * nic o hostingu.
 */
export function remoteAddress(url: string): string | undefined {
  const trimmed = url.trim();
  // `transport::adres` (np. `ext::<komenda>`) to komenda z argumentami, czasem z hasłem, a nie adres hostingu.
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed)) return undefined;
  const target = trimmed.includes("://") ? fromUrl(trimmed) : fromScp(trimmed);
  if (!target) return undefined;
  const path = target.path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return target.host === "" || path === "" ? undefined : `${target.host.toLowerCase()}/${path}`;
}

function fromUrl(url: string): { host: string; path: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!NETWORK_SCHEMES.has(parsed.protocol)) return undefined;
  try {
    return { host: parsed.hostname, path: decodeURIComponent(parsed.pathname) };
  } catch {
    return { host: parsed.hostname, path: parsed.pathname };
  }
}

/**
 * Składnia scp (`[użytkownik@]host:ścieżka`): git rozpoznaje ją po dwukropku przed pierwszym `/`. Jednoliterowy
 * „host” to litera dysku Windowsa (`C:\repo`), czyli ścieżka lokalna.
 */
function fromScp(url: string): { host: string; path: string } | undefined {
  const m = /^(?:[^@/]+@)?([^:/]+):(.+)$/s.exec(url);
  const [, host = "", path = ""] = m ?? [];
  return host.length < 2 ? undefined : { host, path };
}
