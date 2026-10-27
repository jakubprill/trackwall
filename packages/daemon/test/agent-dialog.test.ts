import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/infra/errors.ts";
import { readAgentDialog } from "../src/modules/agents/copilot-dialog.ts";
import { LiveSession } from "../src/modules/agents/live-session.ts";
import { screenProcessed } from "./support/live-session.ts";

/** Screens of Copilot CLI 1.0.103 taken from the real binary in tmux (paths replaced, lengths kept). */
function screen(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", "copilot", `dialog-${name}.txt`), "utf8").split("\n");
}

describe("an agent dialog read from the session's screen (ADR-66)", () => {
  test("a command approval gives its heading, the command, the question and the options without the one that needs text", () => {
    expect(readAgentDialog(screen("shell-120"), "approval")).toEqual({
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
    expect(readAgentDialog(screen("create-120"), "approval")).toMatchObject({
      title: "Create file",
      detail: ["notes-with-a-rather-long-name-for-wrapping.txt +2 -0", "/src/app-outside", "", "1 +   hi", "2 +   there"],
      question: "Do you want to create /src/app-outside/notes-with-a-rather-long-name-for-wrapping.txt?",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "Yes, and don't ask again for file operations when in this repo (/src/app-repo)" },
      ],
    });
  });

  test("an approval with Yes as its only digit option, as for a PowerShell command on Windows, gives that one option", () => {
    const onlyYes = screen("shell-120").filter((l) => !l.includes("2. Yes, and don't ask again"));

    expect(readAgentDialog(onlyYes, "approval")).toMatchObject({ options: [{ key: "1", label: "Yes" }] });
  });

  test("the screen of a new session waiting for its first prompt has no question dialog", () => {
    expect(
      readAgentDialog(readFileSync(join(import.meta.dir, "fixtures", "copilot", "prompt-box-120.txt"), "utf8").split("\n"), "question"),
    ).toBeUndefined();
  });

  test("lines Copilot CLI wrapped in a narrow terminal are joined into the same dialog", () => {
    expect(readAgentDialog(screen("shell-72"), "approval")).toEqual(readAgentDialog(screen("shell-120"), "approval"));
    expect(readAgentDialog(screen("create-72"), "approval")).toEqual(readAgentDialog(screen("create-120"), "approval"));
  });

  test("a question from the agent gives only its text", () => {
    expect(readAgentDialog(screen("question-120"), "question")).toEqual({
      kind: "question",
      question: "Which database should the service use?",
    });
  });

  test("only the kind asked for is read, so an approval left above a question does not hide it", () => {
    expect(readAgentDialog(screen("question-120"), "approval")).toBeUndefined();
    expect(readAgentDialog([...screen("shell-120"), ...screen("question-120")], "question")).toMatchObject({ kind: "question" });
  });

  test("with the selection moved to the option that takes text, the approval cannot be answered with a digit", () => {
    const moved = screen("shell-120").map((l) => l.replace("❯ 1.", "  1.").replace("  3. No", "❯ 3. No"));

    expect(moved.some((l) => l.includes("❯ 3. No"))).toBe(true);
    expect(readAgentDialog(moved, "approval")).toBeUndefined();
  });

  test("a box the agent's output draws, indented as all its output is, is not a dialog", () => {
    const indented = screen("shell-120").map((l) => (l.startsWith("╭") ? ` ${l}` : l));

    expect(readAgentDialog(indented, "approval")).toBeUndefined();
  });

  test("an approval taller than the terminal, cut above its heading, is read with the notification's text as its heading", () => {
    const full = readAgentDialog(screen("mcp-45"), "approval");
    const cut = readAgentDialog(screen("mcp-cut-14"), "approval", "Use MCP tool: trackwall/verify_task");

    expect(full).toMatchObject({ title: "verify_task" });
    expect(cut).toEqual({
      kind: "approval",
      title: "Use MCP tool: trackwall/verify_task",
      detail: ["…", "}"],
      question: "Do you want to use this tool?",
      options: full?.kind === "approval" ? full.options : [],
    });
  });

  test("a cut approval without a notification's text gets a plain heading", () => {
    expect(readAgentDialog(screen("mcp-cut-14"), "approval")).toMatchObject({ title: "Approval request" });
  });

  test("a box cut above counts only with nothing but the tab bar and blank lines above it", () => {
    const lines = screen("mcp-cut-14");
    const withOutput = lines.map((l, i) => (i === 1 ? " ● The agent's output" : l));

    expect(readAgentDialog(withOutput, "approval")).toBeUndefined();
  });

  test("a screen without a dialog, or with a numbered list that is not one, gives none", () => {
    expect(readAgentDialog(["❯ write the file", " ● done", "", "❯"], "approval")).toBeUndefined();
    expect(readAgentDialog(["╭────╮", "│ Plan │", "│ 1. Read the code │", "│ 2. Fix it │", "╰────╯"], "approval")).toBeUndefined();
  });
});

const sessions: LiveSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

/** A session in a 120×30 terminal (or `terminal`) whose screen shows `name` and whose last hook record is `notification`. */
async function sessionShowing(
  name: string,
  notificationType: string,
  prompt: () => string | undefined = () => undefined,
  terminal: { cols: number; rows: number; message?: string } = { cols: 120, rows: 30 },
) {
  const typedText = { count: 0 };
  const hooksFile = join(mkdtempSync(join(tmpdir(), "trackwall-dialog-")), "hooks.jsonl");
  writeFileSync(hooksFile, "");
  const session = new LiveSession({
    id: "s1",
    repo: "shop",
    task: null,
    cols: terminal.cols,
    rows: terminal.rows,
    hooksFile,
    promptOnStart: false,
    hasConversation: false,
    program: "copilot",
    run: () => ({ kind: "running", runId: "r1", startedAt: "2026-10-25T12:00:00.000Z", pid: 1 }),
    prompt,
    onPromptSent: () => {},
    onUserText: () => {
      typedText.count++;
    },
    onEvent: () => {},
  });
  sessions.push(session);
  const written: string[] = [];
  session.connect({ write: (data) => written.push(data), resize: () => {} });
  session.output(new TextEncoder().encode(screen(name).join("\r\n")));
  const notify = (type: string) => {
    const notification = {
      event: "notification",
      receivedAt: 0,
      payload: { notification_type: type, message: terminal.message },
      omitted: [],
    };
    appendFileSync(hooksFile, `${JSON.stringify(notification)}\n`);
    session.tick();
  };
  notify(notificationType);
  await screenProcessed(session);
  return { session, written, notify, hooksFile, typedText };
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

  test("an approval cut above in a short terminal shows with the text of its notification as the heading", async () => {
    const terminal = { cols: 100, rows: 14, message: "Use MCP tool: trackwall/verify_task" };
    const { session, written } = await sessionShowing("mcp-cut-14", "permission_prompt", undefined, terminal);
    const dialog = session.view()?.dialog;
    expect(dialog).toMatchObject({
      kind: "approval",
      title: "Use MCP tool: trackwall/verify_task",
      question: "Do you want to use this tool?",
    });

    session.answerDialog(dialog?.id ?? "", "1");

    expect(written).toEqual(["1"]);
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

  test("the same request asked again is a new dialog, which an answer to the first one does not reach", async () => {
    const { session, written, notify } = await sessionShowing("shell-120", "permission_prompt");
    const first = session.view()?.dialog?.id ?? "";
    session.answerDialog(first, "1");
    notify("permission_prompt");

    const again = session.view()?.dialog;
    expect(again).toMatchObject({ kind: "approval", question: "Do you want to run this command?" });
    expect(again?.id).not.toBe(first);
    expect(dialogError(() => session.answerDialog(first, "1"))).toBe("dialog_changed");
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

    expect(dialogError(() => session.answerDialog(dialog?.id ?? "", "1"))).toBe("bad_request");
    expect(written).toEqual([]);
  });

  test("a dialog left on the screen after the state moved on is not shown", async () => {
    const { session } = await sessionShowing("shell-120", "elicitation_dialog");

    expect(session.view()).toMatchObject({ state: { state: "Input" }, dialog: null });
  });
});

describe("the daemon's prompt and a dialog on the screen (ADR-62, ADR-68)", () => {
  test("is not typed while the screen shows the agent's question, although the hooks put the session in its input box", async () => {
    const { session, written, hooksFile } = await sessionShowing("question-120", "elicitation_dialog", () => "read the message");
    // An end of the turn whose hook came while the question is still open: the hooks say input box, the screen the question.
    appendFileSync(hooksFile, `${JSON.stringify({ event: "agentStop", receivedAt: 0, payload: {}, omitted: [] })}\n`);
    session.tick();
    expect(session.view()?.dialog).toMatchObject({ kind: "question" });

    expect(session.askToRead()).toBe("queued");

    expect(written).toEqual([]);
  });

  test("an answer typed into the agent's question is not text the user left in the input box", async () => {
    const { session, written, typedText } = await sessionShowing("question-120", "elicitation_dialog", () => "read the message");

    session.input("PostgreSQL");

    expect(typedText.count).toBe(0);
    expect(written).toEqual(["PostgreSQL"]);
  });
});
