import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Two children of one JSX parent with the same `key` (e.g. two strips keyed by the session's id so that they mount again
 * with the next session) make React keep stale copies of them: the Sessions view filled with dozens of identical
 * environment strips after a session stopped. React only warns in the console, so this test reads the sources instead. It
 * sees the keys written on the children themselves; elements kept in variables and the keys of a `.map()` are out of its reach.
 */
const SRC = join(import.meta.dir, "..", "src");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
    .map((e) => join(e.parentPath, e.name));
}

/** The JSX elements a child of a parent can render: itself, or what `cond && <A />` and `cond ? <A /> : <B />` give. */
function renderedElements(node: ts.Node): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return [node];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node))
    return node.expression === undefined ? [] : renderedElements(node.expression);
  if (ts.isBinaryExpression(node)) return renderedElements(node.right);
  if (ts.isConditionalExpression(node)) return [...renderedElements(node.whenTrue), ...renderedElements(node.whenFalse)];
  return [];
}

function keyOf(element: ts.JsxElement | ts.JsxSelfClosingElement, source: ts.SourceFile): string | null {
  const attributes = ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes;
  const key = attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(source) === "key");
  return key !== undefined && ts.isJsxAttribute(key) && key.initializer !== undefined ? keyText(key.initializer, source) : null;
}

/** `"x"` and `{"x"}` are one key, and so are `session?.id` and `session.id` once both render. */
function keyText(initializer: ts.JsxAttributeValue, source: ts.SourceFile): string {
  const value = ts.isJsxExpression(initializer) && initializer.expression !== undefined ? initializer.expression : initializer;
  return ts.isStringLiteral(value) ? JSON.stringify(value.text) : value.getText(source).replaceAll("?.", ".");
}

/** `file:line key` for each key a parent's children repeat; the branches of one ternary are one slot, so they may share one. */
function repeatedKeys(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const seen = new Set<string>();
      for (const child of node.children) {
        const keys = new Set(renderedElements(child).flatMap((e) => keyOf(e, source) ?? []));
        for (const key of keys) {
          if (seen.has(key)) {
            const line = source.getLineAndCharacterOfPosition(child.getStart(source)).line + 1;
            found.push(`${relative(SRC, file)}:${line} ${key}`);
          }
          seen.add(key);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("no two children of one JSX parent share a key", () => {
  expect(tsxFiles(SRC).flatMap(repeatedKeys)).toEqual([]);
});
