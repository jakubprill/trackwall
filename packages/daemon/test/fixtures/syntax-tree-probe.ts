/**
 * Sonda parsera tree-sitter (ADR-37) uruchamiana przez `syntax-tree.test.ts` pod Bun, pod Node i jako binarka
 * z `bun build --compile`: wypisuje JSON z polami rekordu Javy, parametrami `data class` Kotlina i tym, czy pliki
 * WASM leżą w binarce.
 */
import { readSyntaxTree } from "../../src/modules/cards/syntax-tree.ts";
import { isInBinary } from "../../src/platform/runtime.ts";
import { grammarFiles } from "../../src/platform/syntax-grammars.ts";

const java = await readSyntaxTree("java", "public record OrderDto(String id, List<Line> lines) {}", (root) =>
  root.descendantsOfType("formal_parameter").map((p) => `${p.childForFieldName("name")?.text}: ${p.childForFieldName("type")?.text}`),
);
const kotlin = await readSyntaxTree("kotlin", "data class OrderDto(val id: String, val total: BigDecimal)", (root) =>
  root.descendantsOfType("class_parameter").map((p) => p.text),
);
const embedded = Object.values(await grammarFiles()).every(isInBinary);
console.log(JSON.stringify({ java, kotlin, embedded }));
