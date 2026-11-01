import {
  type BoardItemAuthor,
  type ContentDigest,
  type KnowledgeEntry,
  type KnowledgeKind,
  type KnowledgeList,
  type KnowledgeListEntry,
  type KnowledgeName,
  knowledgeIsAbout,
} from "@trackwall/protocol";
import { type ApprovedFile, ApprovedFolder } from "../../infra/approved-folder.ts";
import { DomainError } from "../../infra/errors.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";
import { KNOWLEDGE_FILE_FORMAT, writeKnowledgeFile } from "./knowledge-file.ts";

/**
 * Workspace knowledge (ADR-170, §4.21): short facts about the user's repos as files in `.trackwall/knowledge` of the
 * projects folder, beside the board, so they survive a rebuilt container and the user reads them in an editor. Every
 * session in an entry's repos reads it in its instructions, so an entry is text that steers later agents without anyone
 * reading it again: only content the user approved counts (`ApprovedFolder`), the user's own writes are approved as they
 * are written, and an agent's proposal waits until the user approves it in the version they saw.
 */

/** Entries the folder holds at most; an agent is refused before the list stops reading the user's own. */
const MAX_KNOWLEDGE_ENTRIES = 200;
/** Proposals waiting for the user at most, so an agent in a loop cannot bury the user's list. */
export const MAX_WAITING_PROPOSALS = 20;
/**
 * Characters of entries one session's instructions take at most, a few pages; the rest it reads with `list_knowledge`.
 * Entries about the session's repo come before the ones about the whole workspace.
 */
export const SESSION_KNOWLEDGE_MAX_CHARS = 4000;

export interface KnowledgeDeps {
  /** The projects folder; refused (`bad_request`, `projects_dir_unavailable`) when it is not set or not there. */
  projectsDir: () => Promise<string>;
  /** `knowledge-approvals.json` in the state folder. */
  approvalsFile: string;
  log: (msg: string) => void;
}

/** An entry as it is written: everything but the time, which the write sets. */
export type NewKnowledgeEntry = Omit<KnowledgeEntry, "updatedAt" | "writtenBy">;

/** The approved entries a session's instructions carry, and how many more about its place it can list. */
export interface SessionKnowledge {
  entries: KnowledgeEntry[];
  more: number;
}

export class Knowledge {
  readonly #folder: ApprovedFolder<KnowledgeEntry>;

  constructor(deps: KnowledgeDeps) {
    this.#folder = new ApprovedFolder({
      format: KNOWLEDGE_FILE_FORMAT,
      dir: async () => ensureTrackwallDir(await deps.projectsDir(), "knowledge"),
      approvalsFile: deps.approvalsFile,
      log: deps.log,
    });
  }

  async list(): Promise<KnowledgeList> {
    const { files, problems } = await this.#folder.list();
    return { entries: files.map(listEntry), problems };
  }

  /** The approved entries about `repo` (all of them without one), by kind and name; what an agent may read. */
  async approved(filter: { repo?: string; kind?: KnowledgeKind } = {}): Promise<KnowledgeEntry[]> {
    const { files } = await this.#folder.list();
    return files
      .filter((f) => f.approved)
      .map((f) => f.value)
      .filter(
        (e) => (filter.repo === undefined || knowledgeIsAbout(e, filter.repo)) && (filter.kind === undefined || e.kind === filter.kind),
      );
  }

  /**
   * What a session's instructions carry: in a repo, the approved entries about that repo and then the ones about the
   * whole workspace; elsewhere (the supervisor, a free session) only the ones about the whole workspace. Whole entries
   * up to `SESSION_KNOWLEDGE_MAX_CHARS`.
   */
  async forSession(repo: string | null): Promise<SessionKnowledge> {
    const all = await this.approved();
    const own = repo === null ? [] : all.filter((e) => e.repos.includes(repo));
    const shared = all.filter((e) => e.repos.length === 0);
    const entries: KnowledgeEntry[] = [];
    let chars = 0;
    for (const entry of [...own, ...shared]) {
      if (chars + entry.text.length > SESSION_KNOWLEDGE_MAX_CHARS) break;
      entries.push(entry);
      chars += entry.text.length;
    }
    return { entries, more: own.length + shared.length - entries.length };
  }

  /** The user's own entry, typed in the UI: approved as written. */
  async write(entry: NewKnowledgeEntry): Promise<KnowledgeListEntry> {
    await this.#assertRoom(entry.name, { waiting: false });
    return this.#save(entry, { kind: "user" }, { approve: true });
  }

  /** An agent's proposal (`propose_knowledge`): it waits for the user unless its bytes are the approved ones. */
  async propose(entry: NewKnowledgeEntry, task: string | null): Promise<KnowledgeListEntry> {
    await this.#assertRoom(entry.name, { waiting: true });
    return this.#save(entry, { kind: "agent", task }, { approve: false });
  }

  /** Approves the entry's content as the user saw it (`digest`). */
  async approve(name: KnowledgeName, digest: ContentDigest): Promise<KnowledgeListEntry> {
    return listEntry(await this.#folder.approve(name, digest));
  }

  remove(name: KnowledgeName): Promise<void> {
    return this.#folder.remove(name);
  }

  async #save(entry: NewKnowledgeEntry, writtenBy: BoardItemAuthor, how: { approve: boolean }): Promise<KnowledgeListEntry> {
    const full: KnowledgeEntry = { ...entry, writtenBy, updatedAt: new Date().toISOString() };
    const written = await this.#folder.write(entry.name, writeKnowledgeFile(full), how);
    return { ...full, ...written };
  }

  /** A new name needs room in the folder, and an agent's proposal also among the ones waiting for the user. */
  async #assertRoom(name: string, { waiting }: { waiting: boolean }): Promise<void> {
    const { files } = await this.#folder.list();
    const others = files.filter((f) => f.name !== name);
    if (others.length >= MAX_KNOWLEDGE_ENTRIES)
      throw new DomainError(
        "bad_request",
        `workspace knowledge holds ${MAX_KNOWLEDGE_ENTRIES} entries, its limit; remove some in Plan first`,
      );
    if (waiting && others.filter((f) => !f.approved).length >= MAX_WAITING_PROPOSALS)
      throw new DomainError(
        "bad_request",
        `${MAX_WAITING_PROPOSALS} knowledge entries already wait for the user's approval; mention this one in your result instead`,
      );
  }
}

function listEntry({ value, digest, approved }: ApprovedFile<KnowledgeEntry>): KnowledgeListEntry {
  return { ...value, digest, approved };
}
