import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CommitHash, RepoCard } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";

/**
 * Pamięć podręczna kart po hashu commita (ADR-25): karta zależy tylko od drzewa commita i wersji ekstraktorów, więc
 * policzona raz nie zmienia się. W pamięci daemona i w plikach `<katalog stanu>/cards/<commit>.json`, żeby restart
 * daemona nie czytał od nowa setek repo. Plik z inną wersją ekstraktorów albo uszkodzony liczy się jak brak. Karta,
 * której część zależała od czasu liczenia (ADR-38), zostaje tylko w pamięci, więc następny start daemona liczy ją od nowa.
 */

/**
 * Wersja ekstraktorów zapisana z kartą. Zmiana tego, co ekstraktor wyciąga z tych samych plików, musi ją podbić,
 * bo inaczej stare karty z dysku zostaną przy starym wyniku.
 */
const EXTRACTOR_VERSION = 4;
/** Tyle plików kart zostaje na dysku; starsze (po czasie zapisu) są usuwane przy starcie daemona. */
const MAX_FILES = 2000;
/** Tyle kart trzyma pamięć daemona; starsze wypadają w kolejności dodania. */
const MAX_IN_MEMORY = 1000;

/** Policzona karta; `persist: false`, gdy wynik zależał od chwili liczenia i nie powinien przetrwać restartu. */
export interface ComputedCard {
  card: RepoCard;
  persist: boolean;
}

const CacheFile = z.object({ extractorVersion: z.literal(EXTRACTOR_VERSION), card: RepoCard });

export class CardCache {
  private readonly dir: string;
  private readonly log: (msg: string) => void;
  private readonly memory = new Map<string, RepoCard>();
  /** Karty w trakcie liczenia po commicie: dwa pytania o ten sam commit (lista i karta naraz) czytają gita raz. */
  private readonly computing = new Map<string, Promise<RepoCard>>();

  constructor(dir: string, log: (msg: string) => void) {
    this.dir = dir;
    this.log = log;
  }

  /**
   * Karta commita z pamięci albo z dysku, a bez niej policzona przez `compute` i zapamiętana (na dysku tylko z
   * `persist`). Całe zadanie (odczyt dysku i liczenie) trafia do `computing` przed pierwszym `await`, więc równoczesne
   * pytanie o ten sam commit dostaje to samo zadanie.
   */
  getOrCompute(commit: string, compute: () => Promise<ComputedCard>): Promise<RepoCard> {
    const running = this.computing.get(commit);
    if (running) return running;
    const job = (async () => {
      const cached = await this.get(commit);
      if (cached) return cached;
      const { card, persist } = await compute();
      this.remember(card);
      if (persist) this.save(card);
      return card;
    })().finally(() => this.computing.delete(commit));
    this.computing.set(commit, job);
    return job;
  }

  private async get(commit: string): Promise<RepoCard | undefined> {
    const cached = this.memory.get(commit);
    if (cached) return cached;
    // Tylko pełny hash trafia do nazwy pliku.
    if (!CommitHash.safeParse(commit).success) return undefined;
    let text: string;
    try {
      text = await readFile(this.file(commit), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = CacheFile.safeParse(JSON.parse(text));
      if (!parsed.success) return undefined;
      this.remember(parsed.data.card);
      return parsed.data.card;
    } catch {
      return undefined;
    }
  }

  /** Nieudany zapis na dysk trafia do logu: karta w pamięci działa dalej, najwyżej restart policzy ją od nowa. */
  private save(card: RepoCard): void {
    if (!CommitHash.safeParse(card.commit).success) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(this.file(card.commit), JSON.stringify({ extractorVersion: EXTRACTOR_VERSION, card }));
    } catch (err) {
      this.log(`failed to save card ${card.commit}: ${String(err)}`);
    }
  }

  /** Usuwa najstarsze pliki ponad `MAX_FILES`; każdy nowy commit repo to nowy plik, więc bez tego katalog tylko rośnie. */
  async prune(): Promise<void> {
    const names = (await readdir(this.dir).catch(() => [])).filter((n) => n.endsWith(".json"));
    if (names.length <= MAX_FILES) return;
    const files = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await stat(join(this.dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    files.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(files.slice(MAX_FILES).map((f) => rm(join(this.dir, f.name), { force: true })));
  }

  private remember(card: RepoCard): void {
    this.memory.delete(card.commit);
    this.memory.set(card.commit, card);
    const oldest = this.memory.keys().next();
    if (this.memory.size > MAX_IN_MEMORY && !oldest.done) this.memory.delete(oldest.value);
  }

  private file(commit: string): string {
    return join(this.dir, `${commit}.json`);
  }
}
