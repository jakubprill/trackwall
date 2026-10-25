import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/infra/errors.ts";
import { readAgentDialog } from "../src/modules/agents/copilot-dialog.ts";
import { LiveSession } from "../src/modules/agents/live-session.ts";

/** Screens of Copilot CLI 1.0.103 taken from the real binary in tmux (paths replaced, lengths kept). */
function screen(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", "copilot", `dialog-${name}.txt`), "utf8").split("\n");
}

describe("an agent dialog read from the session's screen (ADR-66)", () => {
  test("a command approval gives its heading, the command, the question and the options without the one that needs text", () => {
    expect(readAgentDialog(screen("shell-120"))).toEqual({
      id: expect.any(String),
      kind: "approval",
      title: "Write a file",
      detail: ["touch /src/app-outside/x.txt"],
      question: "Do you want to run this command?",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "Yes, and don't ask again for `touch` in this repo (/src/app-repo)" },
      ],
    });
  });

  test("a file approval gives the file and its lines as the detail", () => {
    expect(readAgentDialog(screen("create-120"))).toMatchObject({
      title: "Create file",
      detail: ["notes-with-a-rather-long-name-for-wrapping.txt +2 -0", "/src/app-outside", "", "1 +   hi", "2 +   there"],
      question: "Do you want to create /src/app-outside/notes-with-a-rather-long-name-for-wrapping.txt?",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "Yes, and don't ask again for file operations when in this repo (/src/app-repo)" },
      ],
    });
  });

  test("lines Copilot CLI wrapped in a narrow terminal are joined into the same dialog with the same id", () => {
    expect(readAgentDialog(screen("shell-72"))).toEqual(readAgentDialog(screen("shell-120")));
    expect(readAgentDialog(screen("create-72"))).toEqual(readAgentDialog(screen("create-120")));
  });

  test("a question from the agent gives only its text, with no options to answer it from outside", () => {
    expect(readAgentDialog(screen("question-120"))).toEqual({
      id: expect.any(String),
      kind: "question",
      title: "Copilot needs information.",
      detail: [],
      question: "Which database should the service use?",
      options: [],
    });
  });

  test("a screen without a dialog, or with a numbered list that is not one, gives none", () => {
    expect(readAgentDialog(["❯ write the file", " ● done", "", "❯"])).toBeUndefined();
    expect(readAgentDialog(["╭────╮", "│ Plan │", "│ 1. Read the code │", "│ 2. Fix it │", "╰────╯"])).toBeUndefined();
  });
});

const sessions: LiveSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

/** A session in a 120×30 terminal whose screen shows `name` and whose last hook record is `notification`. */
async function sessionShowing(name: string, notificationType: string) {
  const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-dialog-")), "hooks.jsonl");
  writeFileSync(hooksFile, "");
  const session = new LiveSession({
    id: "s1",
    repo: "shop",
    task: null,
    cols: 120,
    rows: 30,
    hooksFile,
    promptOnStart: false,
    run: () => ({ kind: "running", runId: "r1", startedAt: "2026-10-25T12:00:00.000Z", pid: 1 }),
  });
  sessions.push(session);
  const written: string[] = [];
  session.connect({ write: (data) => written.push(data), resize: () => {} });
  session.output(new TextEncoder().encode(screen(name).join("\r\n")));
  const notification = { event: "notification", receivedAt: 0, payload: { notification_type: notificationType }, omitted: [] };
  appendFileSync(hooksFile, `${JSON.stringify(notification)}\n`);
  session.tick();
  // The screen image is ready once the emulator has processed the output.
  await new Promise<void>((resolve) =>
    session.attach(
      () => {},
      () => resolve(),
      () => {},
    ),
  );
  return { session, written };
}

function dialogError(answer: () => void): string | undefined {
  try {
    answer();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return undefined;
}

describe("answering an agent dialog from outside the terminal (ADR-66)", () => {
  test("a session asking for approval shows its dialog, and an option types its digit as a key would", async () => {
    const { session, written } = await sessionShowing("shell-120", "permission_prompt");
    const dialog = session.view()?.dialog;
    expect(dialog).toMatchObject({ kind: "approval", question: "Do you want to run this command?" });

    session.answerDialog(dialog?.id ?? "", "2");

    expect(written).toEqual(["2"]);
    expect(session.view()).toMatchObject({ state: { state: "Working", source: "keyboard" }, dialog: null });
  });

  test("stop types Esc, which ends the agent's turn", async () => {
    const { session, written } = await sessionShowing("create-120", "permission_prompt");

    session.answerDialog(session.view()?.dialog?.id ?? "", "stop");

    expect(written).toEqual(["\u001b"]);
    expect(session.view()?.state).toMatchObject({ state: "Input", reason: "key escape" });
  });

  test("an answer to a dialog that is no longer on the screen types nothing", async () => {
    const { session, written } = await sessionShowing("shell-120", "permission_prompt");
    const id = session.view()?.dialog?.id ?? "";
    session.input("1");

    expect(dialogError(() => session.answerDialog(id, "1"))).toBe("dialog_changed");
    expect(dialogError(() => session.answerDialog("another dialog", "1"))).toBe("dialog_changed");
    expect(written).toEqual(["1"]);
  });

  test("an option the dialog does not offer outside the terminal is refused", async () => {
    const { session, written } = await sessionShowing("shell-120", "permission_prompt");

    expect(dialogError(() => session.answerDialog(session.view()?.dialog?.id ?? "", "3"))).toBe("bad_request");
    expect(written).toEqual([]);
  });

  test("a question is shown while the session waits for input, but it cannot be answered from outside", async () => {
    const { session, written } = await sessionShowing("question-120", "elicitation_dialog");
    const dialog = session.view()?.dialog;
    expect(dialog).toMatchObject({ kind: "question", question: "Which database should the service use?" });

    expect(dialogError(() => session.answerDialog(dialog?.id ?? "", "1"))).toBe("dialog_changed");
    expect(written).toEqual([]);
  });

  test("a dialog left on the screen after the state moved on is not shown", async () => {
    const { session } = await sessionShowing("shell-120", "elicitation_dialog");

    expect(session.view()).toMatchObject({ state: { state: "Input" }, dialog: null });
  });
});
