import { z } from "zod";
import { SessionList } from "./agents.ts";
import { RunningMiseTask } from "./mise.ts";

/**
 * Zdarzenia daemona na WebSocket `/ws` (§5.2, ADR-36). Zdarzenie niesie całą migawkę jednego tematu (lista sesji,
 * działające taski mise), a nie różnicę: klient, który się podłącza albo łączy ponownie, dostaje najpierw migawkę
 * każdego tematu, więc nie potrzebuje bufora zdarzeń ani `resync`. Daemon wysyła zdarzenie tylko wtedy, gdy migawka
 * tematu się zmieniła. Klient niczego nie wysyła.
 */

export const EVENTS_SOCKET_PATH = "/ws";
/** Podprotokół WebSocketu zdarzeń; token idzie obok niego (`SOCKET_TOKEN_PREFIX`). */
export const EVENTS_SUBPROTOCOL = "trackwall.events";
/** Klient nie odbiera zdarzeń (za dużo w buforze daemona); łączy się ponownie i zaczyna od migawek. */
export const EVENTS_CLOSE_SLOW = 4429;

/**
 * Numer zdarzenia w jednym działaniu daemona, rosnący przez wszystkie tematy; mówi, które z dwóch zdarzeń jest
 * nowsze, nie ile zdarzeń przepadło.
 */
const Seq = z.number().int().nonnegative();

export const DaemonEvent = z.discriminatedUnion("type", [
  /** Lista sesji i zadań, ta sama co `agents/sessions` (§4.4). */
  z.object({ seq: Seq, type: z.literal("sessions.changed"), payload: SessionList }),
  /** Działające taski mise wszystkich repo, to samo co `mise/running` (§4.7). */
  z.object({ seq: Seq, type: z.literal("mise.running.changed"), payload: z.array(RunningMiseTask) }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;
export type DaemonEventType = DaemonEvent["type"];
/** Migawka tematu zdarzenia danego typu. */
export type DaemonEventPayload<T extends DaemonEventType> = Extract<DaemonEvent, { type: T }>["payload"];
