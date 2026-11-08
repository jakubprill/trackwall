import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { promptBoxLayout } from "@trackwall/protocol";
import { viewer, waitFor } from "../test/support/agents.ts";
import { REFERENCE_COLS, REFERENCE_ROWS } from "../test/support/copilot-reference.ts";
import { screenLines } from "../test/support/screen-lines.ts";
import { startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// TEMPORARY diagnostic for the framed box on Windows; removed before the PR.
setDefaultTimeout(240_000);
let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model, {}, { COPILOT_PROMPT_FRAME: "1" });
});
afterAll(async () => {
  await daemon.stop();
  await model.close();
});

const ANSWERS = "\u001b]10;rgb:dddd/dddd/dddd\u001b\\\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\";

async function probe(mode: "on-query" | "eager") {
  const { agents } = daemon.facade;
  const s = await agents.startSupervisor("new", "terminal");
  const w = viewer(agents, s.id);
  w.attachment.resize(REFERENCE_COLS, REFERENCE_ROWS);
  let sent = 0;
  const timer = setInterval(() => {
    const asked = w.text().split("\u001b]11;?").length - 1;
    if (mode === "eager" ? sent < 20 : sent < asked) {
      w.attachment.input(ANSWERS);
      sent++;
    }
  }, mode === "eager" ? 100 : 10);
  await waitFor(agents, s.id, (x) => x.state !== null, "state", 60_000);
  await Bun.sleep(4000);
  clearInterval(timer);
  const osc = [...w.text().matchAll(/\u001b\][^\u0007\u001b]*/g)].map((m) => JSON.stringify(m[0]));
  const csiQueries = [...w.text().matchAll(/\u001b\[[>?=]?[0-9;]*[cnqtu]/g)].map((m) => JSON.stringify(m[0]));
  const layout = promptBoxLayout(await screenLines(w));
  process.stdout.write(`DIAG ${process.platform} ${mode}: layout=${layout} sent=${sent} osc=${[...new Set(osc)].join(" ")} csi=${[...new Set(csiQueries)].join(" ")}\n`);
  w.attachment.detach();
  await agents.stop(s.id);
  return layout;
}

test("diag", async () => {
  const a = await probe("on-query");
  const b = await probe("eager");
  expect([a, b]).toBeDefined();
});
