import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { agentsApi, graphApi, type TaskProposal } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "l".repeat(43);
const MONEY = "money/src/main/java/com/example/money/Money.java";

const pom = (artifact: string, inside = "") =>
  [
    "<project>",
    "  <groupId>com.example.shop</groupId>",
    `  <artifactId>${artifact}</artifactId>`,
    "  <version>1.0.0</version>",
    inside,
    "</project>",
  ].join("\n");
const dependsOnMoney =
  "  <dependencies><dependency><groupId>com.example.shop</groupId><artifactId>money</artifactId><version>1.0.0</version></dependency></dependencies>";

const money = [
  "package com.example.money;",
  "",
  "public final class Money {",
  "  public Money(long cents) {}",
  "  public Money[] split(int parts) { return new Money[parts]; }",
  "  public long cents() { return 0; }",
  "}",
].join("\n");

let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: {
      // A library in a module of its own, next to the build that publishes it.
      "money-lib": {
        "pom.xml": pom("money-parent", "  <modules><module>money</module></modules>"),
        "money/pom.xml": pom("money"),
        [MONEY]: money,
      },
      billing: {
        "pom.xml": pom("billing", dependsOnMoney),
        "src/main/java/com/example/billing/Invoice.java": [
          "package com.example.billing;",
          "",
          "import com.example.money.Money;",
          "",
          "public class Invoice { Money[] parts(Money total) { return total.split(3); } }",
        ].join("\n"),
      },
      // Uses the library too, but not the changed type.
      shipping: {
        "pom.xml": pom("shipping", dependsOnMoney),
        "src/main/java/com/example/shipping/Parcel.java":
          "package com.example.shipping;\n\nimport java.util.List;\n\npublic class Parcel {}",
      },
    },
    miseCommand: ["mise"],
  });
  gitIn(join(daemon.projects, "money-lib"), "config", "user.name", "Repo User");
  gitIn(join(daemon.projects, "money-lib"), "config", "user.email", "user@example.com");
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function proposals(): TaskProposal[] {
  return daemon.facade.agents.sessions().proposals;
}

describe.skipIf(process.versions.bun === undefined)(
  "library impact: a task that changes a public type of a package proposes a task to each repo importing it (ADR-201; real git, cards and code search, fake Copilot CLI)",
  () => {
    test("removing a public method lists the type with the repo that imports it, which joins ring 1 and gets a proposal when the turn ends", async () => {
      const task = await daemon.post(agentsApi.createTask, { repo: "money-lib", prompt: "Drop Money.split", approvals: "ask" });
      commitFiles(
        task.worktree,
        { [MONEY]: money.replace("  public Money[] split(int parts) { return new Money[parts]; }\n", "") },
        "Drop split",
      );

      const changed = await daemon.post(graphApi.changedEndpoints, { task: task.id });
      expect(changed.types).toEqual([
        {
          change: "changed",
          package: "com.example.money",
          type: "com.example.money.Money",
          declaration: false,
          members: ["split(int)"],
          evidence: { path: MONEY, line: 3 },
          users: [{ repo: "billing", evidence: { path: "src/main/java/com/example/billing/Invoice.java", line: 3 } }],
        },
      ]);
      expect(changed.impact).toEqual([{ repo: "billing", ring: 1, uses: ["money-lib"], calls: [], through: [], sure: true }]);

      const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
      if (!session) throw new Error("the task has no running session");
      const window = viewer(daemon.facade.agents, session.id);
      window.attachment.input("go on\r");
      await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Approval", "the approval");
      window.attachment.input("1");
      await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Input", "the end of the turn");
      window.attachment.detach();
      const until = Date.now() + 20_000;
      while (proposals().length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));

      expect(proposals().map((p) => [p.repo, p.title, p.fromImpact])).toEqual([["billing", "Update to the API change in money-lib", true]]);
      expect(proposals()[0]?.prompt).toBe(
        [
          "The task “Drop Money.split” in money-lib changes public types of its packages that billing imports:",
          "- changed type com.example.money.Money (split(int)), imported at src/main/java/com/example/billing/Invoice.java:3",
          "",
          "Update billing to the new contract. Read that task's change with get_changed_endpoints and get_task_changes before you change code.",
        ].join("\n"),
      );

      await daemon.facade.agents.stop(session.id);
      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    }, 60_000);
  },
);
