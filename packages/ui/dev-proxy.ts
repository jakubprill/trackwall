import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Tylko `vite dev`: przekazuje `/api/*` do działającego daemona z tokenem z `daemon.json`.
 * Plik jest czytany przy każdym żądaniu, więc kolejność startu daemona i Vite nie ma znaczenia.
 * Przeglądarka nigdy nie widzi tokenu, a daemon widzi żądanie bez `Origin`, jak od klienta spoza przeglądarki.
 */
export function daemonDevProxy(): Plugin {
  const file = join(process.env.PITWALL_HOME ?? join(homedir(), ".pitwall"), "daemon.json");
  return {
    name: "pitwall-daemon-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        let daemon: { port: number; token: string };
        try {
          daemon = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: { code: "internal", message: `daemon nie działa (brak ${file})` } }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const upstream = await fetch(`http://127.0.0.1:${daemon.port}/api${req.url ?? ""}`, {
            method: req.method,
            headers: { authorization: `Bearer ${daemon.token}`, "content-type": req.headers["content-type"] ?? "application/json" },
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          });
          res.statusCode = upstream.status;
          res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: { code: "internal", message: `daemon nie odpowiada: ${String(err)}` } }));
        }
      });
    },
  };
}
