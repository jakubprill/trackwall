import { randomUUID } from "node:crypto";
import type { ProposedBy, TaskProposal } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Propozycje zadań (ADR-39): zadania zgłoszone narzędziem MCP `propose_task`, które czekają na decyzję użytkownika
 * w widoku Sessions. Tylko w pamięci daemona, jak sesje, które je zgłaszają: po restarcie sesja proponująca i tak
 * nie żyje, więc nikt nie czeka na odpowiedź. Odrzucone znikają z listy, ale ich identyfikatory zostają, żeby sesja,
 * która na propozycję czeka, dostała `proposal_rejected` zamiast `not_found`, razem z powodem od użytkownika (ADR-55).
 */

/** Tyle propozycji może czekać naraz: sesja w pętli nie zasypie listy, a człowiek i tak nie przejrzy więcej. */
export const MAX_PENDING_PROPOSALS = 20;
/** Tyle ostatnich odrzuceń pamięta daemon dla czekających sesji. */
const REMEMBERED_REJECTIONS = 100;

export class TaskProposals {
  /** Od najnowszej. */
  #pending: TaskProposal[] = [];
  /**
   * Zatwierdzone, których zadanie jeszcze się tworzy: zostają na liście, żeby panel w UI nie zniknął w trakcie
   * zatwierdzania (z błędem i poprawionym poleceniem), ale drugi raz nikt ich nie zatwierdzi ani nie odrzuci.
   */
  readonly #approving = new Set<string>();
  /** Rejected id to the user's reason (`null` without one), oldest first; the oldest drop out after `REMEMBERED_REJECTIONS`. */
  readonly #rejected = new Map<string, string | null>();

  list(): TaskProposal[] {
    return [...this.#pending];
  }

  add(proposal: { repo: string; title: string; prompt: string; proposedBy: ProposedBy }): TaskProposal {
    if (this.#pending.length >= MAX_PENDING_PROPOSALS) {
      throw new DomainError(
        "bad_request",
        `${MAX_PENDING_PROPOSALS} task proposals are already waiting for the user; wait for their decision`,
      );
    }
    const added: TaskProposal = { id: randomUUID(), ...proposal, createdAt: new Date().toISOString() };
    this.#pending = [added, ...this.#pending];
    return added;
  }

  /** Propozycja, która czeka na decyzję (nie ta w trakcie zatwierdzania), albo `undefined`. */
  find(id: string): TaskProposal | undefined {
    return this.#approving.has(id) ? undefined : this.#pending.find((p) => p.id === id);
  }

  /** Czekająca propozycja (`not_found`, gdy jej nie ma, bo użytkownik już zdecydował). */
  get(id: string): TaskProposal {
    const proposal = this.find(id);
    if (!proposal) throw new DomainError("not_found", `no task proposal ${id} is waiting for a decision`);
    return proposal;
  }

  /** Propozycja zatwierdzona w trakcie tworzenia zadania albo `undefined`. */
  approving(id: string): TaskProposal | undefined {
    return this.#approving.has(id) ? this.#pending.find((p) => p.id === id) : undefined;
  }

  /** Bierze czekającą propozycję do zatwierdzenia; drugie `take` albo `reject` to `not_found`, dopóki trwa. */
  take(id: string): TaskProposal {
    const proposal = this.get(id);
    this.#approving.add(id);
    return proposal;
  }

  /** Koniec zatwierdzania: z `restore` propozycja znów czeka (zadanie nie powstało), bez niego znika, bo jest już zadaniem. */
  release(id: string, restore: boolean): void {
    this.#approving.delete(id);
    if (!restore) this.#pending = this.#pending.filter((p) => p.id !== id);
  }

  reject(id: string, reason: string | null): void {
    this.get(id);
    this.#pending = this.#pending.filter((p) => p.id !== id);
    this.#rejected.set(id, reason);
    for (const old of this.#rejected.keys()) {
      if (this.#rejected.size <= REMEMBERED_REJECTIONS) break;
      this.#rejected.delete(old);
    }
  }

  /** How the user rejected the proposal, or `undefined` when it was not rejected (or long enough ago to be forgotten). */
  rejection(id: string): { reason: string | null } | undefined {
    return this.#rejected.has(id) ? { reason: this.#rejected.get(id) ?? null } : undefined;
  }
}
