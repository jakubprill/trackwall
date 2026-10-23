import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_FILE, DaemonFile, TRACKWALL_HOME_ENV } from "@trackwall/protocol";
import type { Plugin } from "vite";

/**
 * Tylko `vite dev`: przekazuje `/api/*` do daemona z `pnpm dev` z tokenem z `daemon.json`.
 * Daemon deweloperski trzyma stan w `<repo>/.trackwall-dev`, osobno od wydanej aplikacji w `~/.trackwall`
 * (`TRACKWALL_HOME` nadpisuje oba).
 * Plik jest czytany przy każdym żądaniu, więc kolejność startu daemona i Vite nie ma znaczenia,
 * a przeglądarka nigdy nie widzi tokenu.
 *
 * Proxy dokłada token, więc samo musi pilnować tego, co daemon sprawdza po `Origin` (§5.2): przepuszcza tylko
 * żądania ze strony Vite. Bez tego dowolna strona w przeglądarce mogłaby wysłać formularz POST na
 * `127.0.0.1:5173/api/...` i wykonać akcję w daemonie.
 */
/** Ten sam katalog podaje skrypt `dev` daemona (`--home ../../.trackwall-dev`). */
const DEV_HOME = fileURLToPath(new URL("../../.trackwall-dev", import.meta.url));

export function daemonDevProxy(): Plugin {
  return {
    name: "trackwall-daemon-dev-proxy",
    apply: "serve",
    configureServer(server) {
      const file = join(process.env[TRACKWALL_HOME_ENV] || DEV_HOME, DAEMON_FILE);
      server.middlewares.use("/api", (req, res) => {
        const reply = (status: number, message: string) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: { code: status === 403 ? "forbidden_origin" : "internal", message } }));
        };

        const port = server.config.server.port;
        const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
        const origin = req.headers.origin;
        const site = req.headers["sec-fetch-site"];
        if ((origin !== undefined && !own.includes(origin)) || (site !== undefined && site !== "same-origin" && site !== "none")) {
          return reply(403, "żądanie spoza strony Vite");
        }

        let daemon: DaemonFile;
        try {
          daemon = DaemonFile.parse(JSON.parse(readFileSync(file, "utf8")));
        } catch {
          return reply(503, `daemon nie działa (brak albo uszkodzony ${file})`);
        }

        // node:http, nie fetch: bez obejścia przez HTTP_PROXY i ze strumieniowaniem ciała w obie strony.
        const upstream = request(
          {
            host: "127.0.0.1",
            port: daemon.port,
            path: `/api${req.url ?? ""}`,
            method: req.method,
            agent: false,
            headers: {
              authorization: `Bearer ${daemon.token}`,
              "content-type": req.headers["content-type"] ?? "application/json",
              ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}),
            },
          },
          (up) => {
            res.statusCode = up.statusCode ?? 502;
            res.setHeader("content-type", up.headers["content-type"] ?? "application/json");
            // Zerwane połączenie w połowie odpowiedzi: przeglądarka ma dostać błąd, a nie wiszące żądanie.
            up.on("aborted", () => res.destroy());
            up.on("error", () => res.destroy());
            up.pipe(res);
          },
        );
        upstream.on("error", (err) => reply(502, `daemon nie odpowiada: ${err.message}`));
        req.pipe(upstream);
      });
    },
  };
}
