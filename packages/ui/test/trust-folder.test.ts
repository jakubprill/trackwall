import { describe, expect, test } from "bun:test";
import { trustedFolderMessage } from "../src/lib/trust-folder.ts";

describe("trustedFolderMessage: what the Trust folder button says after the click (ADR-270)", () => {
  test("a folder that was added names the folder and the copy of the file as it was", () => {
    expect(
      trustedFolderMessage({ folder: "/home/me/dev", added: true, backup: "/home/me/.copilot/config.before-trackwall-trust.json" }),
    ).toBe(
      "Copilot CLI now trusts /home/me/dev; sessions you start from now on are not asked. The file as it was: /home/me/.copilot/config.before-trackwall-trust.json",
    );
  });

  test("a folder added to a config.json that did not exist has no copy to name", () => {
    expect(trustedFolderMessage({ folder: "/home/me/dev", added: true, backup: null })).toBe(
      "Copilot CLI now trusts /home/me/dev; sessions you start from now on are not asked.",
    );
  });

  test("a folder that a trusted folder covered already names that folder, and nothing was written", () => {
    expect(trustedFolderMessage({ folder: "/home/me", added: false, backup: null })).toBe("Copilot CLI already trusts /home/me.");
  });
});
