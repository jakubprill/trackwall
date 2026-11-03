import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { type FolderTerminal, MAX_FOLDER_TERMINALS, type RunState, type TerminalPlace } from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { KeyedQueue } from "../../infra/keyed-queue.ts";
import { type ScreenViewer, TerminalScreen } from "../../infra/terminal-screen.ts";

/**
 * Folder terminals (§4.23, ADR-185): the user's own shell in a repo root or a task's worktree, in a PTY from `procs`,
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
  /** The same entries by place (`placeKey`): one per place. */
  readonly #atPlace = new Map<string, Entry>();
  /**
   * Starts and closes of one place run one after another, so a double click opens one shell, and a task's end
   * (`closeTask`) waits for a start in flight in its worktree and closes what it started.
   */
  readonly #places = new KeyedQueue();

  constructor(deps: FolderTerminalsDeps) {
    this.#deps = deps;
  }

  /** The place's terminal: the live one, or its ended one with a new shell, or a new one. */
  start(place: TerminalPlace): Promise<FolderTerminal> {
    return this.#places.run(placeKey(place), async () => {
      const known = this.#atPlace.get(placeKey(place));
      if (known && this.#live(known)) return this.#view(known);
      if (!known && this.#entries.size >= MAX_FOLDER_TERMINALS)
        throw new DomainError(
          "bad_request",
          `${MAX_FOLDER_TERMINALS} terminals are open, also ended ones; close one before opening another`,
        );
      const cwd = await this.#folder(place);
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
    await this.#places.run(placeKey(entry.place), () => this.#close(entry));
  }

  /** Closes the terminal in a task's worktree, also one starting now, before the worktree goes away. */
  closeTask(task: string): Promise<void> {
    const key = taskKey(task);
    return this.#places.run(key, async () => {
      const entry = this.#atPlace.get(key);
      if (entry) await this.#close(entry);
    });
  }

  /** Within the place's queue; a close that another one already finished does nothing. */
  async #close(entry: Entry): Promise<void> {
    if (this.#entries.get(entry.id) !== entry) return;
    await this.#deps.procs.stop(terminalOwner(entry.id));
    this.#forget(entry);
  }

  /** The place's folder; a worktree must be a folder of its own, since its agent could swap it for a link to anywhere. */
  async #folder(place: TerminalPlace): Promise<string> {
    const folder = await this.#deps.folder(place);
    if (place.task === null) return folder;
    const stat = await lstat(folder).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory())
      throw new DomainError("repo_unavailable", `${folder} is not a folder (it is gone, or a link)`);
    return folder;
  }

  #add(place: TerminalPlace): Entry {
    const entry: Entry = { id: randomUUID(), place, screen: new TerminalScreen(INITIAL_COLS, INITIAL_ROWS), closers: new Set() };
    this.#entries.set(entry.id, entry);
    this.#atPlace.set(placeKey(place), entry);
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
        // Output the PTY still flushes after a close must not reach a disposed screen.
        onData: (bytes) => {
          if (this.#entries.get(entry.id) === entry) entry.screen.write(bytes);
        },
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
    this.#atPlace.delete(placeKey(entry.place));
    for (const closed of entry.closers) closed();
    entry.closers.clear();
    entry.screen.dispose();
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

/**
 * Without the last lines of an ended shell: they are what the user typed and saw (a `cat .env`), which the screen
 * already holds for the windows, and the list goes to every listener of the events.
 */
function viewOf(entry: Entry, run: RunState): FolderTerminal {
  const shown = run.kind === "exited" ? { ...run, lastLines: [] } : run;
  return { id: entry.id, repo: entry.place.repo, task: entry.place.task, run: shown };
}

/** A start that failed as the user can act on it: a folder that went away, or a shell this daemon cannot run. */
function startError(err: unknown): unknown {
  if (!(err instanceof SpawnFailure)) return err;
  return new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "terminal_unavailable", err.message);
}

/** A task id is unique across repos, so a task's place is its id alone. */
function placeKey(place: TerminalPlace): string {
  return place.task === null ? `repo:${place.repo}` : taskKey(place.task);
}

function taskKey(task: string): string {
  return `task:${task}`;
}
