import { describe, expect, test } from "bun:test";
import { taskSlug } from "../src/modules/agents/task-branch.ts";

const ID = "3f2a9c1e-0000-4000-8000-000000000000";

describe("nazwa gałęzi zadania z polecenia", () => {
  test("pierwsze słowa polecenia bez polskich znaków i początek identyfikatora", () => {
    expect(taskSlug("Popraw błąd w żółtym przycisku logowania", ID)).toBe("popraw-blad-w-zoltym-przycisku-3f2a9c");
  });

  test("znaki spoza liter i cyfr tylko rozdzielają słowa, a polecenie bez nich daje nazwę zastępczą", () => {
    expect(taskSlug("--yolo: napraw #42 (pilne!)", ID)).toBe("yolo-napraw-42-pilne-3f2a9c");
    expect(taskSlug("??? 🚀", ID)).toBe("zadanie-3f2a9c");
  });

  test("pierwsze słowo dłuższe niż limit jest ucinane, a nie gubione", () => {
    expect(taskSlug("a".repeat(50), ID)).toBe(`${"a".repeat(32)}-3f2a9c`);
  });
});
