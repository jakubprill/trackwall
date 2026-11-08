/**
 * Builds the extension into one CommonJS file, `dist/extension.js`, with `@trackwall/protocol` and zod inside: VS Code
 * loads it with `require`, provides `vscode` itself and installs no dependencies from a `.vsix`.
 *
 *   bun apps/vscode/scripts/build.ts
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(root, "src", "extension.ts")],
  outdir: join(root, "dist"),
  target: "node",
  format: "cjs",
  external: ["vscode"],
  minify: true,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(join(root, "dist", "extension.js"));
