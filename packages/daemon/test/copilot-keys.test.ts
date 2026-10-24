import { describe, expect, test } from "bun:test";
import { sessionKey, stateFromKey } from "../src/modules/agents/copilot-keys.ts";

describe("klawisze w terminalu sesji Copilot CLI", () => {
  test("liczy się tylko pojedynczy Enter, Esc albo Ctrl+C; tekst, wklejka i strzałki nie są klawiszem odpowiedzi", () => {
    expect(sessionKey("\r")).toBe("enter");
    expect(sessionKey("\u001b")).toBe("escape");
    expect(sessionKey("\u0003")).toBe("interrupt");
    expect(sessionKey("y\r")).toBeUndefined();
    expect(sessionKey("\u001b[B")).toBeUndefined();
    expect(sessionKey("\u001b[200~ls\r\u001b[201~")).toBeUndefined();
  });

  test("Enter przy prośbie o zgodę albo o zatwierdzenie planu to praca z pewnością medium", () => {
    expect(stateFromKey("enter", "Approval")).toEqual({ state: "Working", source: "keyboard", confidence: "medium", reason: "key enter" });
    expect(stateFromKey("enter", "Plan")).toMatchObject({ state: "Working" });
  });

  test("Esc i Ctrl+C w trakcie pracy albo przy prośbie o zgodę przerywają turę, więc sesja czeka na Ciebie", () => {
    expect(stateFromKey("escape", "Approval")).toEqual({ state: "Input", source: "keyboard", confidence: "medium", reason: "key escape" });
    expect(stateFromKey("escape", "Working")).toMatchObject({ state: "Input" });
    expect(stateFromKey("interrupt", "Working")).toMatchObject({ state: "Input", reason: "key interrupt" });
  });

  test("Enter przy wpisywaniu promptu albo komendy nie zmienia stanu, bo turę zgłasza hook, a komenda w rodzaju /model nie ma hooka", () => {
    expect(stateFromKey("enter", "Input")).toBeUndefined();
    expect(stateFromKey("enter", "Working")).toBeUndefined();
    expect(stateFromKey("escape", "Input")).toBeUndefined();
    expect(stateFromKey("enter", undefined)).toBeUndefined();
    expect(stateFromKey("escape", "Done")).toBeUndefined();
  });
});
