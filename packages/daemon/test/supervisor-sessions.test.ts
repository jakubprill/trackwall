import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@trackwall/protocol";
import { LastSupervisorFile } from "../src/modules/agents/last-supervisor.ts";
import type { SessionLaunch } from "../src/modules/agents/resumable-sessions.ts";
import { SupervisorSessions } from "../src/modules/agents/supervisor-sessions.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function supervisorView(id: string, run: "running" | "exited"): Session {
  return { id, repo: null, supervisor: true, task: null, run: { kind: run } } as Session;
}

const RESUMED: SessionLaunch = {
  view: "terminal",
  id: "left",
  args: ["--resume=left"],
  promptOnStart: false,
  hasConversation: true,
  conversation: "left",
};

/**
 * Supervisors over a list the test fills, whose starts finish only when the test lets them; `refusal` is what the
 * configuration refuses a start with.
 */
function makeSupervisors(listed: Session[] = [], refusal?: Error) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-supervisor-"));
  homes.push(home);
  const steps: string[] = [];
  const pending: Array<() => void> = [];
  const supervisors = new SupervisorSessions({
    sessions: { views: () => listed, has: (id) => listed.some((s) => s.id === id) },
    lastSupervisor: new LastSupervisorFile(join(home, "last-supervisor.json"), () => {}),
    projectsDir: async () => home,
    check: async () => {
      steps.push("check");
      if (refusal) throw refusal;
    },
    launch: (spec) => {
      steps.push(`launch ${spec.id}`);
      return new Promise((resolve) =>
        pending.push(() => {
          const started = supervisorView(spec.id, "running");
          listed.push(started);
          resolve(started);
        }),
      );
    },
    close: (id) => {
      steps.push(`close ${id}`);
      listed.splice(
        listed.findIndex((s) => s.id === id),
        1,
      );
    },
  });
  /** Lets the starts under way finish. */
  const finishStarts = async () => {
    while (pending.length === 0) await Bun.sleep(1);
    for (const finish of pending.splice(0)) finish();
  };
  return { supervisors, steps, finishStarts };
}

describe("supervisor sessions", () => {
  test("the supervisor the previous daemon left is not resumed while a supervisor starts", async () => {
    const { supervisors, finishStarts } = makeSupervisors();
    const starting = supervisors.start("new", "terminal");

    await expect(supervisors.resume(RESUMED)).rejects.toThrow("a supervisor already runs");

    await finishStarts();
    await starting;
  });

  test("the supervisor the previous daemon left is not resumed while a supervisor runs", async () => {
    const { supervisors } = makeSupervisors([supervisorView("running", "running")]);

    await expect(supervisors.resume(RESUMED)).rejects.toThrow("a supervisor already runs");
  });

  test("a new supervisor closes the ended one only once it has started", async () => {
    const { supervisors, steps, finishStarts } = makeSupervisors([supervisorView("ended", "exited")]);

    const starting = supervisors.start("new", "terminal");
    await finishStarts();
    const started = await starting;

    expect(steps).toEqual([`launch ${started.id}`, "close ended"]);
  });

  test("going on with the ended supervisor's conversation keeps its screen when the configuration refuses the start", async () => {
    const listed = [supervisorView("left", "exited")];
    const { supervisors, steps } = makeSupervisors(listed, new Error("supervisorModel: a model id is letters, digits, dots"));

    await expect(supervisors.resume(RESUMED)).rejects.toThrow("supervisorModel");

    expect(steps).toEqual(["check"]);
    expect(listed.map((s) => s.id)).toEqual(["left"]);
  });

  test("going on with the ended supervisor's conversation closes it after the check and before the start under its id", async () => {
    const { supervisors, steps, finishStarts } = makeSupervisors([supervisorView("left", "exited")]);

    const starting = supervisors.resume(RESUMED);
    await finishStarts();
    await starting;

    expect(steps).toEqual(["check", "close left", "launch left"]);
  });
});
