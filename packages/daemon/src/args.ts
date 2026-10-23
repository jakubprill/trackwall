import { parseArgs } from "node:util";

export interface DaemonArgs {
  port: number;
  ui: boolean;
  uiDir?: string;
  parent?: number;
  home?: string;
  allowOrigins: string[];
  help: boolean;
  version: boolean;
}

export const USAGE = `trackwall-daemon [opcje]

  --ui             otwórz UI w domyślnej przeglądarce (tryb bez Tauri)
  --ui-dir <dir>   katalog zbudowanego UI (domyślnie ./ui obok binarki)
  --port <n>       port na 127.0.0.1 (domyślnie losowy)
  --parent <pid>   PID procesu Tauri, który uruchomił daemon
  --home <dir>     katalog stanu (domyślnie ~/.trackwall albo TRACKWALL_HOME)
  --allow-origin <origin>
                   dodatkowy origin przeglądarki z dostępem do API (np. serwer Vite przy tauri dev)
  --version        wypisz wersję
  -h, --help       ta pomoc
`;

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      ui: { type: "boolean", default: false },
      "ui-dir": { type: "string" },
      port: { type: "string", default: "0" },
      parent: { type: "string" },
      home: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const port = toInt(values.port, "--port");
  if (port < 0 || port > 65535) throw new Error("--port poza zakresem 0-65535");
  const allowOrigins = values["allow-origin"] ?? [];
  for (const origin of allowOrigins) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin)) {
      throw new Error(`--allow-origin przyjmuje tylko http://127.0.0.1:<port> albo http://localhost:<port>, dostał "${origin}"`);
    }
  }
  const parent = values.parent === undefined ? undefined : toInt(values.parent, "--parent");
  return {
    port,
    ui: values.ui ?? false,
    uiDir: values["ui-dir"],
    parent,
    home: values.home,
    allowOrigins,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function toInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} oczekuje liczby całkowitej, dostał "${value}"`);
  return n;
}
