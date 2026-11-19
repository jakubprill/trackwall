import { randomUUID } from "node:crypto";
import { type FolderTerminal, MAX_FOLDER_TERMINALS, type RunState, type TerminalPlace } from "@trackwall/protocol";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { KeyedQueue } from "../../infra/keyed-queue.ts";
import { type ScreenViewer, TerminalScreen } from "../../infra/terminal-screen.ts";
import { checkedPlaceFolder } from "./place-folder.ts";
import type { ShellPlacesStore } from "./shell-places.ts";

/**
 * Folder terminals (§4.23, ADR-185): the user's own shell in the projects folder, a repo root or a task's worktree, in a PTY from `procs`,
 * with a screen on the daemon side like a session's, so a window that connects later starts from the current screen.
 * One terminal per place: a second start hands back the live one. A close takes the terminal off its place at once and
 * ends its shell after, so the place opens a new shell while the old one is still ending. A shell ends with the daemon
 * like every other group, but its place does not (ADR-283): `ShellPlaces` keeps the places whose shell runs, and the
 * next daemon opens a new shell in each (`reopenLeft`), with a line on its screen saying so. The place comes as ids and
 * the shell from the daemon's environment, so a request never names a path or a program.
 */

/** The size a terminal starts with, until its first window reports its own. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 30;

/** The first line of a shell the daemon opened again after a restart: the old shell's screen, variables and jobs are gone. */
const REOPENED_NOTE = "\x1b[2m[Trackwall restarted: this is a new shell in the same folder]\x1b[0m\r\n";

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
  /** The folder of a place: the projects folder or a repo root from `workspace`, a task's worktree from `agents`; `not_found` or `bad_request` otherwise. */
  folder: (place: TerminalPlace) => Promise<string>;
  /** The environment of processes started for the user (`userEnv`). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** The command of the user's shell in that environment (`userShell`). */
  shell: (env: NodeJS.ProcessEnv) => readonly string[];
  /** The places whose shell runs, for the next daemon (ADR-283). */
  places: ShellPlacesStore;
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
  /** The folder the current shell started in; `undefined` until it has started. */
  cwd?: string;
  /** The PTY of the current shell; `undefined` until it has started. */
  pty?: { write(data: string): void; resize(cols: number, rows: number): void };
  /** Windows to tell that the terminal is gone (`close`), so they stop waiting for output. */
  readonly closers: Set<() => void>;
  /** The end of its shell after a close took it off its place; `undefined` while it is the place's terminal. */
  closing?: Promise<void>;
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
  /** The places whose shell the previous daemon left running, until `reopenLeft` takes them (ADR-283). */
  #left: TerminalPlace[];

  /** Reads the places the previous daemon left before anything here can follow new ones into the same file. */
  constructor(deps: FolderTerminalsDeps) {
    this.#deps = deps;
    this.#left = deps.places.read();
  }

  /** The place's terminal: the live one, or its ended one with a new shell, or a new one. */
  start(place: TerminalPlace): Promise<FolderTerminal> {
    return this.#open(place, false);
  }

  /**
   * Daemon start: a new shell in every place where one ran when the previous daemon stopped (ADR-283), one after
   * another. A place that cannot have one any more (its task ended, its repo or the projects folder is gone) goes to
   * the log; a place the user opened meanwhile keeps the shell it has.
   */
  async reopenLeft(): Promise<void> {
    const left = this.#left;
    this.#left = [];
    for (const place of left) {
      try {
        const terminal = await this.#open(place, true);
        this.#deps.log(`folder terminal ${terminal.id} opened again after a restart (${placeKey(place)})`);
      } catch (err) {
        this.#deps.log(`not opening a shell again in ${placeKey(place)}: ${String(err)}`);
      }
    }
  }

  /**
   * Daemon stop, before `procs` ends the shells: the places of the shells that still run stay for the next daemon,
   * whatever the stop does to them; a shell that ended by itself is left out.
   */
  keepForRestart(): void {
    this.#followPlaces();
    this.#deps.places.stopFollowing();
  }

  /** `start`, or the reopening of a place after a restart (`reopened`), whose new shell says so on its first line. */
  #open(place: TerminalPlace, reopened: boolean): Promise<FolderTerminal> {
    return this.#places.run(placeKey(place), async () => {
      let known = this.#atPlace.get(placeKey(place));
      if (known && this.#live(known)) {
        if (!(await this.#movedAway(known))) return this.#view(known);
        // The projects folder changed in Settings: its shell is no longer in it, and ends while the new one starts.
        const moved = known;
        this.#takeOff(moved).catch((err: unknown) => this.#deps.log(`closing folder terminal ${moved.id}: ${String(err)}`));
        known = undefined;
      }
      if (!known) this.#checkRoom();
      const cwd = await this.#folder(place);
      const entry = known ?? this.#add(place);
      try {
        await this.#spawn(entry, cwd, reopened);
      } catch (err) {
        if (!known) this.#forget(entry);
        throw err;
      }
      return this.#view(entry);
    });
  }

  /** Every terminal whose shell has started, also one that ended and was not closed yet; not one being closed. */
  list(): FolderTerminal[] {
    return [...this.#entries.values()].flatMap((entry) => {
      if (entry.closing) return [];
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
    if (entry.closing) throw new DomainError("not_found", `terminal ${id} is closing`);
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

  /**
   * Takes the terminal off its place and closes its windows at once, so that a start of the place right after gets a
   * new shell, then returns once the old shell's end is confirmed and forgets it. When the end is not confirmed
   * (`stop_unconfirmed`), the terminal goes back to its place if the place has no other one yet.
   */
  async close(id: string): Promise<void> {
    const entry = this.#get(id);
    // Only taking it off runs in the place's queue: a start waits for that, not for the shell's end.
    const { ended } = await this.#places.run(placeKey(entry.place), async () => ({ ended: this.#takeOff(entry) }));
    await ended;
  }

  /** Closes the terminal in a task's worktree, also one starting or ending now, before the worktree goes away. */
  async closeTask(task: string): Promise<void> {
    const key = taskKey(task);
    const { ended } = await this.#places.run(key, async () => {
      const here = [...this.#entries.values()].filter((entry) => entry.place.task === task);
      return { ended: Promise.all(here.map((entry) => this.#takeOff(entry))) };
    });
    await ended;
  }

  /** Within the place's queue; the end of a close already under way, or nothing for a terminal already forgotten. */
  #takeOff(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    if (this.#entries.get(entry.id) !== entry) return Promise.resolve();
    this.#atPlace.delete(placeKey(entry.place));
    this.#closeWindows(entry);
    entry.closing = this.#end(entry);
    this.#followPlaces();
    return entry.closing;
  }

  async #end(entry: Entry): Promise<void> {
    try {
      await this.#deps.procs.stop(terminalOwner(entry.id));
    } catch (err) {
      // In the place's queue, so that a start under way finishes first and the place is not given twice.
      await this.#places.run(placeKey(entry.place), async () => this.#putBack(entry));
      throw err;
    }
    this.#forget(entry);
  }

  /**
   * A shell whose end was not confirmed stays the user's to close again, at its place; when the place already has a
   * new shell, `procs` keeps the group and stops it again when the daemon exits.
   */
  #putBack(entry: Entry): void {
    entry.closing = undefined;
    const key = placeKey(entry.place);
    if (!this.#atPlace.has(key)) {
      this.#atPlace.set(key, entry);
      this.#followPlaces();
      return;
    }
    this.#deps.log(`folder terminal ${entry.id}: its shell did not end, and its place has a new one; it is no longer listed`);
    this.#forget(entry);
  }

  /** Whether the projects folder is now another folder than the one the place's shell started in. */
  async #movedAway(entry: Entry): Promise<boolean> {
    if (entry.place.repo !== null) return false;
    return entry.cwd !== (await this.#deps.folder(entry.place));
  }

  async #folder(place: TerminalPlace): Promise<string> {
    return checkedPlaceFolder(place, await this.#deps.folder(place));
  }

  #add(place: TerminalPlace): Entry {
    const entry: Entry = { id: randomUUID(), place, screen: new TerminalScreen(INITIAL_COLS, INITIAL_ROWS), closers: new Set() };
    this.#entries.set(entry.id, entry);
    this.#atPlace.set(placeKey(place), entry);
    return entry;
  }

  #checkRoom(): void {
    if (this.#entries.size < MAX_FOLDER_TERMINALS) return;
    throw new DomainError("bad_request", `${MAX_FOLDER_TERMINALS} terminals are open, also ended ones; close one before opening another`);
  }

  /** Starts the entry's shell in `cwd` and follows its place; a shell `reopened` after a restart says so on its first line. */
  async #spawn(entry: Entry, cwd: string, reopened: boolean): Promise<void> {
    if (reopened) entry.screen.write(new TextEncoder().encode(REOPENED_NOTE));
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
      entry.cwd = cwd;
    } catch (err) {
      throw startError(err);
    }
    this.#deps.log(`folder terminal ${entry.id} started in ${cwd}`);
    this.#followPlaces();
  }

  /** The places of the shells that run now into the file for the next daemon; a shell being closed is off its place already. */
  #followPlaces(): void {
    const running = [...this.#atPlace.values()].filter((entry) => this.#live(entry));
    this.#deps.places.follow(running.map((entry) => entry.place));
  }

  #resize(entry: Entry, cols: number, rows: number): void {
    if (cols === entry.screen.cols && rows === entry.screen.rows) return;
    entry.screen.resize(cols, rows);
    if (this.#running(entry)) entry.pty?.resize(cols, rows);
  }

  #forget(entry: Entry): void {
    this.#entries.delete(entry.id);
    // The place may already have a new terminal, started while this one was ending.
    if (this.#atPlace.get(placeKey(entry.place)) === entry) this.#atPlace.delete(placeKey(entry.place));
    this.#closeWindows(entry);
    entry.screen.dispose();
  }

  #closeWindows(entry: Entry): void {
    for (const closed of entry.closers) closed();
    entry.closers.clear();
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

/** A task id is unique across repos, so a task's place is its id alone; the projects folder is one place of its own. */
function placeKey(place: TerminalPlace): string {
  if (place.task !== null) return taskKey(place.task);
  return place.repo === null ? "projects-folder" : `repo:${place.repo}`;
}

function taskKey(task: string): string {
  return `task:${task}`;
}
