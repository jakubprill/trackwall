import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrustedFolderQuestion } from "../src/components/TrustedFolderNote.tsx";

/** Rendering to markup clicks nothing, so the folder is never trusted from here. */
const trust = () => Promise.reject(new Error("not clicked in a test"));

test("while Copilot CLI does not trust the projects folder, the form asks whether it keeps asking, folded", () => {
  const html = renderToStaticMarkup(<TrustedFolderQuestion folderTrust={{ folder: "/home/you/Projects", trusted: false }} trust={trust} />);

  expect(html).toContain("Copilot CLI asks to trust the folder?");
  expect(html).toContain('aria-expanded="false"');
});

test("once Copilot CLI trusts the projects folder, the form does not ask", () => {
  const html = renderToStaticMarkup(<TrustedFolderQuestion folderTrust={{ folder: "/home/you/Projects", trusted: true }} trust={trust} />);

  expect(html).toBe("");
});

test("while the read of the trust is on its way or failed, the form does not ask", () => {
  expect(renderToStaticMarkup(<TrustedFolderQuestion folderTrust={undefined} trust={trust} />)).toBe("");
});
