import { describe, expect, test } from "bun:test";
import type { Session, Task, TaskProposal } from "../src/agents.ts";
import { VIEWER_TEXT_MAX, ViewerSessionList, viewerSessionList } from "../src/viewer.ts";

const running: Session["run"] = { kind: "running", runId: "r", startedAt: "2026-11-07T10:00:00Z", pid: 42 };

function session(over: Partial<Session>): Session {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    repo: "shop",
    supervisor: false,
    startedAt: "2026-11-07T10:00:00Z",
    run: running,
    state: null,
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model: null,
    ...over,
  };
}

const TASK_ID = "22222222-2222-4222-8222-222222222222";
// Only the fields the viewer reads; the rest of a task never reaches it.
const task = { id: TASK_ID, repo: "shop", title: "Fix the checkout total", prompt: "The tax is added twice for ACME's orders." } as Task;
const TYPED_TASK_ID = "44444444-4444-4444-8444-444444444444";
const typedTask = { id: TYPED_TASK_ID, repo: "shop", title: null, prompt: "Rotate the key sk-live-123 in billing" } as Task;

describe("the viewer's session list", () => {
  test("names each session's state in the UI's words, with its place and task name", () => {
    const list = viewerSessionList({
      sessions: [
        session({
          task: TASK_ID,
          needsAttention: true,
          windowTitle: "Editing Cart.java",
          state: { state: "Approval", source: "hook", confidence: "exact", at: "2026-11-07T10:05:00Z", reason: "hook" },
        }),
        session({ id: "33333333-3333-4333-8333-333333333333", repo: null, supervisor: true }),
      ],
      tasks: [task],
      proposals: [{} as TaskProposal, {} as TaskProposal],
    });
    expect(list).toEqual({
      sessions: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          place: "shop",
          supervisor: false,
          windowTitle: "Editing Cart.java",
          task: TASK_ID,
          taskName: "Fix the checkout total",
          status: { tone: "warning", label: "asking for approval" },
          needsAttention: true,
          live: true,
          since: "2026-11-07T10:05:00Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          place: "Supervisor",
          supervisor: true,
          windowTitle: null,
          task: null,
          taskName: null,
          status: { tone: null, label: "state unknown" },
          needsAttention: false,
          live: true,
          since: "2026-11-07T10:00:00Z",
        },
      ],
      proposals: 2,
    });
    expect(ViewerSessionList.safeParse(list).success).toBe(true);
  });

  test("names a task by its proposal's title only: the prompt of a task the user typed stays in Trackwall", () => {
    const list = viewerSessionList({ sessions: [session({ task: TYPED_TASK_ID })], tasks: [task, typedTask], proposals: [] });
    expect(list.sessions[0]?.taskName).toBeNull();
    expect(JSON.stringify(list)).not.toContain("sk-live");
    expect(JSON.stringify(viewerSessionList({ sessions: [session({ task: TASK_ID })], tasks: [task], proposals: [] }))).not.toContain(
      "ACME",
    );
  });

  test("leaves out the agent dialog and copy request, and cuts a long window title to the schema's limit", () => {
    const list = viewerSessionList({
      sessions: [
        session({
          windowTitle: "x".repeat(500),
          dialog: { kind: "approval", title: "Run this command?", lines: ["rm -rf build"] } as unknown as Session["dialog"],
          copyRequest: { id: "c", text: "a secret note", at: "2026-11-07T10:00:00Z" } as unknown as Session["copyRequest"],
          run: {
            kind: "exited",
            runId: "r",
            startedAt: "2026-11-07T10:00:00Z",
            endedAt: "2026-11-07T10:09:00Z",
            exitCode: 0,
            signal: null,
            stoppedByUser: true,
            lastLines: ["$ rm -rf build"],
          },
        }),
      ],
      tasks: [],
      proposals: [],
    });
    expect(JSON.stringify(list)).not.toContain("rm -rf");
    expect(JSON.stringify(list)).not.toContain("secret note");
    expect(list.sessions[0]?.windowTitle).toHaveLength(VIEWER_TEXT_MAX);
    expect(list.sessions[0]).toMatchObject({ live: false, status: { tone: null, label: "stopped" } });
    expect(ViewerSessionList.safeParse(list).success).toBe(true);
  });
});
