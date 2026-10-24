import { describe, expect, test } from "bun:test";
import { unreferencedDraco } from "../drop-unreferenced-draco.ts";

describe("martwe pliki dekodera Draco w buildzie", () => {
  test("plik Draco, którego nazwy nie ma w żadnym kawałku kodu, wypada; reszta zostaje", () => {
    const files = [
      { fileName: "assets/index-a1.js", code: 'import("./HomeCanvas-b2.js")' },
      { fileName: "assets/HomeCanvas-b2.js", code: "new WebGLRenderer()" },
      { fileName: "assets/draco_decoder-c3.wasm", code: undefined },
      { fileName: "assets/draco_wasm_wrapper-d4.js", code: undefined },
      { fileName: "assets/index-e5.css", code: undefined },
    ];

    expect(unreferencedDraco(files)).toEqual(["assets/draco_decoder-c3.wasm", "assets/draco_wasm_wrapper-d4.js"]);
  });

  test("plik Draco, do którego odwołuje się kod, zostaje", () => {
    const files = [
      { fileName: "assets/index-a1.js", code: 'new URL("draco_decoder-c3.wasm", import.meta.url)' },
      { fileName: "assets/draco_decoder-c3.wasm", code: undefined },
    ];

    expect(unreferencedDraco(files)).toEqual([]);
  });
});
