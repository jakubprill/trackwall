import { randomUUID } from "node:crypto";
import type { ProposedBy, TaskProposal } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Propozycje zadań (ADR-39): zadania zgłoszone narzędziem MCP `propose_task`, które czekają na decyzję użytkownika
 * w widoku Sessions. Tylko w pamięci daemona, jak sesje, które je zgłaszają: po restarcie sesja proponująca i tak
 * nie żyje, więc nikt nie czeka na odpowiedź. Odrzucone znikają z listy, ale ich identyfikatory zostają, żeby sesja,
 * która na propozycję czeka, dostała `proposal_rejected` zamiast `not_found`.
 */

/** Tyle propozycji może czekać naraz: sesja w pętli nie zasypie listy, a człowiek i tak nie przejrzy więcej. */
export const MAX_PENDING_PROPOSALS = 20;
/** Tyle ostatnich odrzuceń pamięta daemon dla czekających sesji. */
const REMEMBERED_REJECTIONS = 100;

export class TaskProposals {
  /** Od najnowszej. */
  #pending: TaskProposal[] = [];
  /** Od najstarszego; najstarsze wypadają po `REMEMBERED_REJECTIONS`. */
  readonly #rejected = new Set<string>();

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

  /** Czekająca propozycja albo `undefined`. */
  find(id: string): TaskProposal | undefined {
    return this.#pending.find((p) => p.id === id);
  }

  /** Czekająca propozycja (`not_found`, gdy jej nie ma, bo użytkownik już zdecydował). */
  get(id: string): TaskProposal {
    const proposal = this.find(id);
    if (!proposal) throw new DomainError("not_found", `no task proposal ${id} is waiting for a decision`);
    return proposal;
  }

  /** Propozycja stała się zadaniem z tym samym identyfikatorem. */
  approved(id: string): void {
    this.#pending = this.#pending.filter((p) => p.id !== id);
  }

  reject(id: string): void {
    this.get(id);
    this.#pending = this.#pending.filter((p) => p.id !== id);
    this.#rejected.add(id);
    for (const old of this.#rejected) {
      if (this.#rejected.size <= REMEMBERED_REJECTIONS) break;
      this.#rejected.delete(old);
    }
  }

  wasRejected(id: string): boolean {
    return this.#rejected.has(id);
  }
}
