import { randomUUID } from "node:crypto";
import { type FolderTerminal, MAX_FOLDER_TERMINALS, type RunState, type TerminalPlace } from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { KeyedQueue } from "../../infra/keyed-queue.ts";
import { type ScreenViewer, TerminalScreen } from "../../infra/terminal-screen.ts";

/**
 * Folder terminals (§4.13, ADR-185): the user's own shell in a repo root or a task's worktree, in a PTY from `procs`,
 * with a screen on the daemon side like a session's, so a window that connects later starts from the current screen.
 * One terminal per place: a second start hands back the live one. They live in memory only; a daemon restart ends
 * them with every other group. The place comes as ids and the shell from the daemon's environment, so a request
 * never names a path or a program.
 */

/** The size a terminal starts with, until its first window reports its own. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;

/** What `procs` gives a folder terminal (§4.2). */
export interface TerminalProcs {
  startTerminal(spec: {
    owner: string;
    command: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
    onData: (bytes: Uint8Array) => void;
  }): Promise<{ run: RunState; terminal: { write(data: string): void; resize(cols: number, rows: number): void } }>;
  state(owner: string): RunState | undefined;
  stop(owner: string): Promise<RunState | undefined>;
}

export interface FolderTerminalsDeps {
  procs: TerminalProcs;
  /** The folder of a place: the repo root from `workspace`, a task's worktree from `agents`; `not_found` or `bad_request` otherwise. */
  folder: (place: TerminalPlace) => Promise<string>;
  /** The environment of processes started for the user (`userEnv`). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** The command of the user's shell in that environment (`userShell`). */
  shell: (env: NodeJS.ProcessEnv) => readonly string[];
  log: (msg: string) => void;
}

/** One terminal window in the UI: keys, size and leaving. */
export interface TerminalWindow {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

interface Entry {
  readonly id: string;
  readonly place: TerminalPlace;
  readonly screen: TerminalScreen;
  /** The PTY of the current shell; `undefined` until it has started. */
  pty?: { write(data: string): void; resize(cols: number, rows: number): void };
  /** Windows to tell that the terminal is gone (`close`), so they stop waiting for output. */
  readonly closers: Set<() => void>;
}

/** The group owner key of a folder terminal in `procs`; only ever built, never taken apart again. */
function terminalOwner(id: string): string {
  return `terminal:${id}`;
}

export class FolderTerminals {
  readonly #deps: FolderTerminalsDeps;
  readonly #entries = new Map<string, Entry>();
  /** Starts and closes of one place run one after another, so a double click opens one shell. */
  readonly #places = new KeyedQueue();

  constructor(deps: FolderTerminalsDeps) {
    this.#deps = deps;
  }

  /** The place's terminal: the live one, or its ended one with a new shell, or a new one. */
  start(place: TerminalPlace): Promise<FolderTerminal> {
    return this.#places.run(placeKey(place), async () => {
      const cwd = await this.#deps.folder(place);
      const known = this.#atPlace(place);
      if (known && this.#live(known)) return this.#view(known);
      if (!known && this.#entries.size >= MAX_FOLDER_TERMINALS)
        throw new DomainError("bad_request", `${MAX_FOLDER_TERMINALS} terminals are open; close one before opening another`);
      const entry = known ?? this.#add(place);
      try {
        await this.#spawn(entry, cwd);
      } catch (err) {
        if (!known) this.#forget(entry);
        throw err;
      }
      return this.#view(entry);
    });
  }

  /** Every terminal whose shell has started, also one that ended and was not closed yet. */
  list(): FolderTerminal[] {
    return [...this.#entries.values()].flatMap((entry) => {
      const run = this.#deps.procs.state(terminalOwner(entry.id));
      return run ? [viewOf(entry, run)] : [];
    });
  }

  /**
   * A window of the terminal: `onSnapshot` gets the screen image, then `viewer` every chunk of output; `onClosed` when
   * the terminal is closed. Keys go to the shell only while it runs.
   */
  attach(id: string, viewer: ScreenViewer, onSnapshot: (snapshot: string) => void, onClosed: () => void): TerminalWindow {
    const entry = this.#get(id);
    const detach = entry.screen.attach(viewer, onSnapshot);
    entry.closers.add(onClosed);
    return {
      input: (data) => {
        if (this.#running(entry)) entry.pty?.write(data);
      },
      resize: (cols, rows) => this.#resize(entry, cols, rows),
      detach: () => {
        entry.closers.delete(onClosed);
        detach();
      },
    };
  }

  /** Ends the shell, once its end is confirmed (`stop_unconfirmed` otherwise, and the terminal stays), and forgets it. */
  async close(id: string): Promise<void> {
    const entry = this.#get(id);
    await this.#places.run(placeKey(entry.place), async () => {
      await this.#deps.procs.stop(terminalOwner(id));
      this.#forget(entry);
    });
  }

  /** Closes every terminal in a task's worktree or anywhere in a repo, before that folder goes away. */
  async closeIn(where: { repo: string } | { task: string }): Promise<void> {
    const inside = [...this.#entries.values()].filter((e) => ("task" in where ? e.place.task === where.task : e.place.repo === where.repo));
    await Promise.all(inside.map((entry) => this.close(entry.id)));
  }

  #add(place: TerminalPlace): Entry {
    const entry: Entry = { id: randomUUID(), place, screen: new TerminalScreen(INITIAL_COLS, INITIAL_ROWS), closers: new Set() };
    this.#entries.set(entry.id, entry);
    return entry;
  }

  async #spawn(entry: Entry, cwd: string): Promise<void> {
    const env = { ...(await this.#deps.env()), TERM: "xterm-256color", COLORTERM: "truecolor" };
    try {
      const { terminal } = await this.#deps.procs.startTerminal({
        owner: terminalOwner(entry.id),
        command: this.#deps.shell(env),
        cwd,
        env,
        cols: entry.screen.cols,
        rows: entry.screen.rows,
        onData: (bytes) => entry.screen.write(bytes),
      });
      entry.pty = terminal;
    } catch (err) {
      throw startError(err);
    }
    this.#deps.log(`folder terminal ${entry.id} started in ${cwd}`);
  }

  #resize(entry: Entry, cols: number, rows: number): void {
    if (cols === entry.screen.cols && rows === entry.screen.rows) return;
    entry.screen.resize(cols, rows);
    if (this.#running(entry)) entry.pty?.resize(cols, rows);
  }

  #forget(entry: Entry): void {
    this.#entries.delete(entry.id);
    for (const closed of entry.closers) closed();
    entry.closers.clear();
    entry.screen.dispose();
  }

  #atPlace(place: TerminalPlace): Entry | undefined {
    return [...this.#entries.values()].find((e) => placeKey(e.place) === placeKey(place));
  }

  #get(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new DomainError("not_found", `no terminal ${id}`);
    return entry;
  }

  /** Not ended: running, or stopping and not confirmed dead yet. */
  #live(entry: Entry): boolean {
    const run = this.#deps.procs.state(terminalOwner(entry.id));
    return run !== undefined && run.kind !== "exited";
  }

  #running(entry: Entry): boolean {
    return this.#deps.procs.state(terminalOwner(entry.id))?.kind === "running";
  }

  #view(entry: Entry): FolderTerminal {
    const run = this.#deps.procs.state(terminalOwner(entry.id));
    if (!run) throw new Error(`folder terminal ${entry.id} has no group in procs`);
    return viewOf(entry, run);
  }
}

function viewOf(entry: Entry, run: RunState): FolderTerminal {
  return { id: entry.id, repo: entry.place.repo, task: entry.place.task, run };
}

/** A start that failed as the user can act on it: a folder that went away, or a shell this daemon cannot run. */
function startError(err: unknown): unknown {
  if (!(err instanceof SpawnFailure)) return err;
  return new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "terminal_unavailable", err.message);
}

function placeKey(place: TerminalPlace): string {
  return `${place.repo}\n${place.task ?? ""}`;
}
