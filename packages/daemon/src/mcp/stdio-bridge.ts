import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { readDaemonFile } from "../discovery.ts";
import { type LoopbackResponse, loopbackRequest } from "../loopback.ts";
import { MCP_PATH } from "./endpoint.ts";

/**
 * Most stdio (`trackwall-daemon mcp-stdio`, §5.3, ADR-23): CLI agenta uruchamia go jako lokalny serwer MCP, a most
 * przekazuje każdą wiadomość JSON-RPC ze stdin do `/mcp` działającego daemona i odpowiedzi na stdout. Port i token
 * czyta z `daemon.json` przy każdej wiadomości, więc restart daemona nie wymaga zmiany konfiguracji agenta, a token
 * nie trafia do niej wcale. Sam niczego nie wie o narzędziach i nie uruchamia daemona.
 */

/** Najdłuższe narzędzie czeka na gita i mise (po 15 s); zapas na wolny dysk sieciowy z folderem z projektami. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Kod JSON-RPC dla błędu po stronie serwera (zakres -32000…-32099 jest dla implementacji). */
const DAEMON_UNAVAILABLE = -32000;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
/**
 * Sonda rewizji 2026-07-28, którą klient (np. Copilot CLI) zaczyna, zanim spróbuje `initialize`. W tej rewizji żądanie
 * HTTP musi powtarzać w nagłówkach pola z treści (wersja, metoda, nazwa narzędzia, wybrane argumenty), a przez stdio
 * nagłówków nie ma; most odpowiada więc jak serwer bez tej metody i klient przechodzi na `initialize`, którym most
 * mówi zawsze. Klienty HTTP rozmawiają z `/mcp` w obu rewizjach.
 */
const DISCOVER_METHOD = "server/discover";

/** Pola wiadomości, których most potrzebuje: identyfikator do odpowiedzi z błędem i metoda do `initialize`. */
const Incoming = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional() });
/** Wiadomość od daemona: przekazywana dalej tylko, gdy to JSON-RPC. */
const Outgoing = z.looseObject({ jsonrpc: z.literal("2.0") });
const Reply = z.looseObject({ id: z.union([z.string(), z.number(), z.null()]).optional() });
const TransportError = z.looseObject({ id: z.null(), error: z.looseObject({}) });
const InitializeResult = z.looseObject({ result: z.looseObject({ protocolVersion: z.string() }) });
const ApiErrorBody = z.object({ error: z.object({ message: z.string() }) });

export interface StdioBridgeOptions {
  /** Katalog stanu daemona z `daemon.json`. */
  home: string;
  input: Readable;
  output: Writable;
  log: (msg: string) => void;
}

/** Działa do końca stdin, a potem czeka na odpowiedzi na wiadomości już wysłane. */
export async function runStdioBridge(o: StdioBridgeOptions): Promise<void> {
  const write = (message: unknown) => o.output.write(`${JSON.stringify(message)}\n`);
  const session: Session = {};
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: o.input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") continue;
    // Wiadomości idą równolegle: agent może wołać kilka narzędzi naraz, a JSON-RPC paruje odpowiedzi po `id`.
    const forwarded = forward(line, o, session, write).catch((err: unknown) => o.log(`przekazanie wiadomości: ${String(err)}`));
    pending.add(forwarded);
    void forwarded.finally(() => pending.delete(forwarded));
  }
  await Promise.all(pending);
}

/**
 * Wersja protokołu uzgodniona w `initialize`: przez HTTP klient podaje ją w nagłówku każdego kolejnego żądania,
 * a przez stdio nie ma nagłówków, więc dopisuje ją most.
 */
interface Session {
  protocolVersion?: string;
}

async function forward(line: string, o: StdioBridgeOptions, session: Session, write: (message: unknown) => void): Promise<void> {
  const incoming = parseIncoming(line);
  if (!incoming.ok) return write(incoming.reply);
  const { id, method } = incoming.message;
  if (method === DISCOVER_METHOD && id !== undefined) {
    return write(errorResponse(id, METHOD_NOT_FOUND, `most stdio Trackwall nie obsługuje ${DISCOVER_METHOD}; użyj initialize`));
  }
  try {
    const replies = (await postToDaemon(line, o.home, session)).map((reply) => withRequestId(reply, id));
    if (method === "initialize") rememberProtocolVersion(replies, session);
    for (const reply of replies) write(reply);
    // Strumień zerwany w trakcie (np. wyjście daemona) zostawiłby żądanie bez odpowiedzi do limitu czasu klienta.
    const answered = replies.some((r) => Reply.safeParse(r).data?.id === id);
    if (method !== undefined && id !== undefined && !answered) throw new DaemonUnavailable("Trackwall nie odpowiedział na żądanie");
  } catch (err) {
    if (!(err instanceof DaemonUnavailable)) throw err;
    o.log(err.message);
    // Na powiadomienie (bez `id`) JSON-RPC nie przewiduje odpowiedzi, więc błąd zostaje tylko w logu.
    if (id !== undefined) write(errorResponse(id, DAEMON_UNAVAILABLE, err.message));
  }
}

/** Pola wiadomości potrzebne mostowi albo odpowiedź z błędem dla linii, która nie jest obiektem JSON-RPC. */
function parseIncoming(
  line: string,
): { ok: true; message: z.infer<typeof Incoming> } | { ok: false; reply: ReturnType<typeof errorResponse> } {
  const json = parseJson(line);
  if (json === undefined) return { ok: false, reply: errorResponse(null, PARSE_ERROR, "wiadomość nie jest poprawnym JSON-em") };
  // Paczek (tablic) nie ma w MCP od rewizji 2025-06-18, a Copilot CLI ich nie wysyła.
  const incoming = Incoming.safeParse(json);
  if (!incoming.success) return { ok: false, reply: errorResponse(null, INVALID_REQUEST, "wiadomość nie jest obiektem JSON-RPC") };
  return { ok: true, message: incoming.data };
}

/**
 * Błąd na poziomie transportu (np. nagłówek odrzucony przez SDK) daemon zwraca z `id: null`, bo HTTP nie wiąże go
 * z żądaniem; przez stdio klient paruje odpowiedzi po `id`, więc most wpisuje identyfikator żądania, na które odpowiada.
 */
function withRequestId(reply: unknown, id: string | number | undefined): unknown {
  const transportError = TransportError.safeParse(reply);
  return transportError.success && id !== undefined ? { ...transportError.data, id } : reply;
}

function rememberProtocolVersion(replies: unknown[], session: Session): void {
  for (const reply of replies) {
    const init = InitializeResult.safeParse(reply);
    if (init.success) session.protocolVersion = init.data.result.protocolVersion;
  }
}

/** Daemon nie działa, nie odpowiada albo odrzucił żądanie; `message` mówi użytkownikowi, co zrobić. */
class DaemonUnavailable extends Error {}

/** Wiadomości JSON-RPC, którymi daemon odpowiedział na `line` (żadnej na powiadomienie). */
async function postToDaemon(line: string, home: string, session: Session): Promise<unknown[]> {
  const daemon = readDaemonFile(home);
  if (!daemon) throw new DaemonUnavailable(`Trackwall nie działa: brak daemon.json w ${home}. Uruchom aplikację Trackwall.`);
  let res: LoopbackResponse;
  try {
    res = await loopbackRequest(daemon.port, MCP_PATH, {
      method: "POST",
      token: daemon.token,
      body: line,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session.protocolVersion && { "mcp-protocol-version": session.protocolVersion }),
      },
    });
  } catch (err) {
    throw new DaemonUnavailable(`Trackwall nie odpowiada na porcie ${daemon.port} (${String(err)}). Uruchom aplikację Trackwall.`);
  }
  const replies = res.headers["content-type"]?.startsWith("text/event-stream") ? sseData(res.body) : [parseJson(res.body)];
  const messages = replies.filter((m) => Outgoing.safeParse(m).success);
  if (res.status >= 400 && messages.length === 0) {
    const api = ApiErrorBody.safeParse(parseJson(res.body));
    throw new DaemonUnavailable(
      `Trackwall odrzucił żądanie (HTTP ${res.status}): ${api.success ? api.data.error.message : "bez komunikatu"}`,
    );
  }
  return messages;
}

/** Treść pól `data:` każdego zdarzenia strumienia SSE jako JSON; zdarzenia bez danych (keepalive) są pomijane. */
function sseData(body: string): unknown[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).replace(/^ /, ""))
        .join("\n"),
    )
    .filter((data) => data !== "")
    .map(parseJson);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorResponse(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
