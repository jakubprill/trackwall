import { describe, expect, test } from "bun:test";
import { DomainError } from "../src/infra/errors.ts";
import { renameError } from "../src/modules/workspace/repo-removal.ts";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename failed`), { code });
}

describe("the error of a repo folder that could not be moved (ADR-83)", () => {
  test("on Windows a busy or locked folder asks the user to close the program holding it", () => {
    for (const code of ["EBUSY", "EPERM"]) {
      const err = renameError(errno(code), "C:\\projects\\shop", "win32");
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).message).toBe(
        `C:\\projects\\shop could not be moved (${code}): a program holds a file in it open, such as an editor, a terminal or a build; close it and approve again`,
      );
    }
  });

  test("a permission error, and any error on macOS and Linux, passes through as it is", () => {
    const denied = errno("EACCES");
    expect(renameError(denied, "C:\\projects\\shop", "win32")).toBe(denied);
    const perm = errno("EPERM");
    expect(renameError(perm, "/projects/shop", "darwin")).toBe(perm);
    expect(renameError(perm, "/projects/shop", "linux")).toBe(perm);
  });
});
