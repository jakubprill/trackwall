import { expect, test } from "bun:test";
import { copilotVersionNotice, readNoticeHiddenFor, saveNoticeHiddenFor } from "../src/lib/copilot-version-notice.ts";

test("a newer Copilot CLI than the tested one gets a strip that says a session's state may show wrong", () => {
  expect(copilotVersionNotice({ version: "1.0.120", tested: "1.0.114", relation: "newer", inContainer: false }, null)).toBe(
    "Copilot CLI 1.0.120 is newer than 1.0.114, the version this Trackwall is tested with: a session's state may show wrong until Trackwall is updated.",
  );
});

test("an older Copilot CLI gets a strip that asks to install the tested version", () => {
  expect(copilotVersionNotice({ version: "1.0.90", tested: "1.0.114", relation: "older", inContainer: false }, null)).toBe(
    "Copilot CLI 1.0.90 is older than 1.0.114, the version this Trackwall is tested with, so sessions may lack what Trackwall relies on. Install Copilot CLI 1.0.114 the way you installed it (npm, Homebrew or WinGet).",
  );
});

test("in a container the strip names the version and where to put it, since an update inside is lost at the next rebuild", () => {
  expect(copilotVersionNotice({ version: "1.0.105", tested: "1.0.114", relation: "older", inContainer: true }, null)).toBe(
    "Copilot CLI 1.0.105 is older than 1.0.114, the version this Trackwall is tested with, so sessions may lack what Trackwall relies on. Install Copilot CLI 1.0.114 where the container gets it: run `mise use -g npm:@github/copilot@1.0.114` in the container, or put that version into its image and rebuild it. An update made any other way is lost at the next rebuild.",
  );
});

test("the tested version, or no version at all, gets no strip", () => {
  expect(copilotVersionNotice({ version: "1.0.114", tested: "1.0.114", relation: "tested", inContainer: false }, null)).toBeNull();
  expect(copilotVersionNotice({ version: null, tested: "1.0.114", relation: "unknown", inContainer: false }, null)).toBeNull();
});

test("a strip hidden for one version stays hidden for it, and the next version shows it again", () => {
  expect(copilotVersionNotice({ version: "1.0.120", tested: "1.0.114", relation: "newer", inContainer: false }, "1.0.120")).toBeNull();
  expect(copilotVersionNotice({ version: "1.0.121", tested: "1.0.114", relation: "newer", inContainer: false }, "1.0.120")).not.toBeNull();
});

test("the version the strip was hidden for is remembered in this browser profile", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  expect(readNoticeHiddenFor(() => storage)).toBeNull();
  saveNoticeHiddenFor(() => storage, "1.0.120");
  expect(readNoticeHiddenFor(() => storage)).toBe("1.0.120");
});

test("storage that refuses access reads as never hidden, and a refused write is forgotten", () => {
  const refuse = () => {
    throw new Error("blocked site data");
  };
  expect(readNoticeHiddenFor(refuse)).toBeNull();
  expect(() => saveNoticeHiddenFor(refuse, "1.0.120")).not.toThrow();
});
