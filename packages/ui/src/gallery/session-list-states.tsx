import type { SessionList, TaskOutcome } from "@trackwall/protocol";
import { tasksReadyToClose } from "@/lib/ready-to-close";
import { findEntry, type SessionSelection, sessionRows } from "@/lib/session-entries";
import { listGroups } from "@/lib/session-groups";
import { supervisorSummary } from "@/lib/supervisor";
import { SessionListPanel } from "@/views/sessions/SessionListPanel";
import type { GalleryState } from "./gallery-state.ts";
import {
  exited,
  LONG_REPO,
  LONG_TITLE,
  mergeRequest,
  minutesAgo,
  NO_DAEMON,
  outcome,
  proposal,
  proposedBy,
  STOPPING,
  sampleId,
  session,
  sessionList,
  stateOf,
  task,
  usage,
  waiting,
} from "./sample-data.ts";
import { NewComputerTips } from "./tips-states.tsx";

/**
 * The Sessions list for `list` as the view shows it, with `selected` picked, the tasks' outcomes, and what the last
 * "Close all" did.
 */
function SessionListOf({
  list,
  selected,
  outcomes = [],
  closeOutcome,
}: {
  list: SessionList | { error: string };
  selected?: SessionSelection;
  outcomes?: readonly TaskOutcome[];
  closeOutcome?: string;
}) {
  const data = "error" in list ? undefined : list;
  const rows = data ? sessionRows(data) : [];
  const current = findEntry(
    rows.map((r) => r.entry),
    selected,
  );
  return (
    <SessionListPanel
      conn={NO_DAEMON}
      sessions={{ data, error: "error" in list ? list.error : undefined, reload: () => {} }}
      rows={rows}
      groups={listGroups(rows)}
      current={current}
      supervisor={supervisorSummary(data, rows)}
      outcomes={new Map(outcomes.map((o) => [o.task, o]))}
      onSelect={() => {}}
      onShowSupervisor={() => {}}
      onShowGroup={() => {}}
      onSessionClosed={() => {}}
      onTaskRemoved={() => {}}
      closeAll={{ ready: data ? tasksReadyToClose(data.tasks, data.sessions) : [], pending: false, outcome: closeOutcome, run: () => {} }}
    />
  );
}

/** Every state a session's row can show, with each kind of usage beside it, from short to the longest. */
const sessionStates: GalleryState = {
  name: "Every session state",
  render: () => (
    <SessionListOf
      selected={{ kind: "session", id: sampleId(3) }}
      list={sessionList({
        sessions: [
          session(1, { usage: usage({ credits: 0.34 }) }),
          session(2, { state: stateOf("Working", "medium"), usage: usage({ credits: 12.5 }), windowTitle: "Running the tests" }),
          waiting(3, 5, { usage: usage({ credits: 1234.56 }) }),
          waiting(4, 135, { state: stateOf("Approval"), usage: usage({ credits: 87.5, partial: true }) }),
          waiting(5, 2, { state: stateOf("Plan", "medium"), usage: usage({ premium: 3 }) }),
          session(6, { stuck: { lastStepAt: minutesAgo(40) }, usage: usage({ tokens: 18_400 }) }),
          session(7, { state: stateOf("Input", "medium"), usage: usage({ credits: 999.99, partial: true }) }),
          session(8, { state: stateOf("Stale", "medium"), usage: usage({ credits: 4.2 }) }),
          session(9, { state: null }),
          session(10, { run: STOPPING }),
          session(11, { run: exited(0), state: stateOf("Done"), usage: usage({ credits: 3 }) }),
          session(12, { run: exited(1), state: stateOf("Error"), usage: usage({ credits: 1 }) }),
          session(13, { run: exited(null, true), usage: usage({ credits: 0.01 }) }),
          session(14, { repo: null, state: stateOf("Input", "medium"), needsAttention: true, waitingSince: minutesAgo(61) }),
        ],
      })}
    />
  ),
};

/** Tasks in each state, Ready for review among them, with every outcome mark: the verdicts and merge requests with their pipelines. */
const taskStates: GalleryState = {
  name: "Tasks and their outcome marks",
  render: () => (
    <SessionListOf
      selected={{ kind: "task", id: sampleId(102) }}
      outcomes={[
        outcome(101, { verification: "passed", mergeRequest: mergeRequest(12, "open", "passed") }),
        outcome(102, { verification: "failed", outdated: true, mergeRequest: mergeRequest(1234, "open", "failed") }),
        outcome(104, { verification: "failed", mergeRequest: mergeRequest(87, "merged", null) }),
        outcome(105, { verification: "running", mergeRequest: mergeRequest(5, "open", "running") }),
        outcome(106, { verification: "cancelled", mergeRequest: mergeRequest(99999, "closed", "manual") }),
        outcome(107, { verification: "passed", outdated: true }),
      ]}
      list={sessionList({
        tasks: [
          task(101, { inReview: true, title: "Add a discount to the cart" }),
          task(102, { inReview: true }),
          task(103, { paused: { at: minutesAgo(30), service: null } }),
          task(104, { inReview: true, readyToClose: true, title: "Fix the footer links" }),
          task(105, { title: "Verify the order export" }),
          task(106, { title: LONG_TITLE }),
          task(107, { inReview: true, plan: "planning" }),
        ],
        sessions: [
          session(101, { task: sampleId(101), state: stateOf("Input"), usage: usage({ credits: 2.75 }) }),
          waiting(102, 3, { task: sampleId(102), state: stateOf("Approval", "medium"), usage: usage({ credits: 1520.4 }) }),
          session(103, { task: sampleId(103), run: exited(null, true) }),
          session(105, { task: sampleId(105), state: stateOf("Working", "medium"), usage: usage({ credits: 12345.67, partial: true }) }),
          session(106, { task: sampleId(106), windowTitle: LONG_TITLE, usage: usage({ tokens: 2_400_000 }) }),
          waiting(107, 48, { task: sampleId(107), state: stateOf("Plan"), usage: usage({ premium: 120 }) }),
        ],
      })}
    />
  ),
};

/** Names, titles and prompts longer than the list is wide. */
const longTexts: GalleryState = {
  name: "Long names and titles",
  render: () => (
    <SessionListOf
      selected={{ kind: "session", id: sampleId(201) }}
      list={sessionList({
        sessions: [
          waiting(201, 7, { repo: LONG_REPO, windowTitle: LONG_TITLE, usage: usage({ credits: 245.1 }) }),
          session(202, { repo: "a", windowTitle: "x" }),
          session(203, { task: sampleId(203), repo: LONG_REPO, state: stateOf("Working", "medium"), usage: usage({ credits: 88.8 }) }),
        ],
        tasks: [task(203, { repo: LONG_REPO, title: LONG_TITLE, inReview: true })],
        proposals: [
          proposal(204, 201, { repo: LONG_REPO, title: LONG_TITLE }),
          proposal(205, 202, { title: LONG_TITLE }),
          proposal(206, 202, {
            kind: "change",
            title: LONG_TITLE,
            parts: [
              { repo: LONG_REPO, note: "" },
              { repo: "shop", note: "" },
            ],
          }),
        ],
      })}
      outcomes={[outcome(203, { verification: "passed", outdated: true, mergeRequest: mergeRequest(4321, "open", "pending") })]}
    />
  ),
};

/** A supervisor with its work, a main session with tasks three levels deep, a change in parts and five groups (the colours go round). */
const groupsAndLevels: GalleryState = {
  name: "Groups, levels and the supervisor",
  render: () => (
    <SessionListOf
      // A group's top row selected: its stripe must stay beside the row's background.
      selected={{ kind: "session", id: sampleId(310) }}
      list={sessionList({
        sessions: [
          waiting(300, 4, { repo: null, supervisor: true, usage: usage({ credits: 31.2 }) }),
          session(301, { task: sampleId(301), usage: usage({ credits: 5 }) }),
          session(310, { repo: "orders-api", usage: usage({ credits: 64 }) }),
          session(311, { task: sampleId(311), repo: "orders-api", state: stateOf("Working", "medium") }),
          waiting(312, 1, { task: sampleId(312), repo: "orders-api" }),
          session(313, { task: sampleId(313), repo: "orders-api", run: exited(0), state: stateOf("Done") }),
          session(320, { repo: "billing" }),
          session(330, { repo: "web-frontend" }),
          session(340, { repo: "search" }),
          session(350, { repo: "catalog" }),
        ],
        tasks: [
          task(301, { proposedBy: proposedBy(300, true), title: "Find why the nightly import fails" }),
          task(302, { proposedBy: proposedBy(300, true), title: "Update the shared build plugin", repo: "billing" }),
          task(311, { repo: "orders-api", proposedBy: proposedBy(310) }),
          task(312, { repo: "orders-api", proposedBy: { session: sampleId(311), supervisor: false, task: sampleId(311) } }),
          task(313, { repo: "orders-api", proposedBy: { session: sampleId(312), supervisor: false, task: sampleId(312) } }),
          task(321, {
            repo: "billing",
            proposedBy: proposedBy(320),
            change: { id: sampleId(900), position: 0, session: null },
            title: "Rename the invoice field",
          }),
          task(322, {
            repo: "web-frontend",
            proposedBy: proposedBy(320),
            change: { id: sampleId(900), position: 1, session: null },
            title: "Rename the invoice field",
          }),
          task(331, { repo: "web-frontend", proposedBy: proposedBy(330) }),
          task(341, { repo: "search", proposedBy: proposedBy(340) }),
          task(351, { repo: "catalog", proposedBy: proposedBy(350) }),
        ],
        proposals: [proposal(360, 300), proposal(361, 310, { repo: "orders-api" }), proposal(362, 310, { repo: "orders-api" })],
      })}
    />
  ),
};

/** The jump to the next waiting entry with each of its labels: the supervisor alone, one entry, many. */
const supervisorWaits: GalleryState = {
  name: "Next waiting: only the supervisor",
  render: () => <SessionListOf list={sessionList({ sessions: [waiting(400, 9, { repo: null, supervisor: true }), session(401)] })} />,
};

const manyWait: GalleryState = {
  name: "Next waiting: twelve entries",
  render: () => (
    <SessionListOf
      selected={{ kind: "session", id: sampleId(500) }}
      list={sessionList({
        sessions: Array.from({ length: 12 }, (_, i) => waiting(500 + i, i * 7 + 1, { repo: i % 2 ? "orders-api" : "shop" })),
      })}
    />
  ),
};

/** The jump to the next waiting entry with its tip, as a new computer shows it the first time (ADR-296). */
const nextWaitingTip: GalleryState = {
  name: "Next waiting with its tip",
  render: () => (
    <NewComputerTips>
      <SessionListOf list={sessionList({ sessions: [waiting(700, 3, { repo: "orders-api" }), session(701)] })} />
    </NewComputerTips>
  ),
};

/** Tasks whose agent said its work is over (ADR-282), counted above the list, and the one the last "Close all" left open. */
const readyToClose: GalleryState = {
  name: "Tasks ready to close, one of them left open by the last Close all",
  render: () => (
    <SessionListOf
      list={sessionList({
        sessions: [waiting(600, 3, { repo: "orders-api" })],
        tasks: [
          task(601, { inReview: true, readyToClose: true, repo: LONG_REPO, title: LONG_TITLE }),
          task(602, { inReview: true, readyToClose: true, title: "Fix the footer links" }),
          task(603, { inReview: true, title: "Add a discount to the cart" }),
        ],
      })}
      closeOutcome={`Closed 3 tasks. Still open, 1 task: ${LONG_REPO} · ${LONG_TITLE}: ending the task would delete: uncommitted changes in the worktree (3).`}
    />
  ),
};

const empty: GalleryState = { name: "No sessions yet", render: () => <SessionListOf list={sessionList({})} /> };

const failed: GalleryState = {
  name: "The list could not load",
  render: () => <SessionListOf list={{ error: "The daemon did not answer: connection refused (127.0.0.1:47823)" }} />,
};

export const SESSION_LIST_STATES: readonly GalleryState[] = [
  sessionStates,
  taskStates,
  longTexts,
  groupsAndLevels,
  supervisorWaits,
  manyWait,
  nextWaitingTip,
  readyToClose,
  empty,
  failed,
];
