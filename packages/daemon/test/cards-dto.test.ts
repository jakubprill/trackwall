import { describe, expect, test } from "bun:test";
import type { ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { extractContracts, responseType } from "../src/modules/cards/endpoint-contracts.ts";
import { CARD_SOURCES, extractCard } from "../src/modules/cards/extract-card.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { snapshotOf } from "./support/snapshot.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

const parsers = await loadSyntaxParsers();

function card(files: Record<string, string>): RepoCard {
  return extractCard(snapshotOf(files), parsers);
}

function contracts(provides: RepoCard["provides"]): string[] {
  return provides
    .filter((p): p is ProvidedEndpoint => p.kind === "endpoint")
    .map((e) => `${e.method ?? "*"} ${e.path} ${e.request ?? "-"} -> ${e.response ?? "-"}`);
}

function dtos(c: RepoCard): string[] {
  return c.dtos.map(
    (d) =>
      `${d.kind} ${d.name}(${[...d.fields.map((f) => `${f.name}: ${f.type}`), ...d.values].join(", ")}) ${d.evidence.path}:${d.evidence.line}`,
  );
}

describe("kontrakty endpointów i DTO", () => {
  test("orders-api: typy żądań i odpowiedzi oraz DTO z rekordu, klasy z Lombokiem i enuma, bez pól static", () => {
    const c = card(fixtureFiles("orders-api"));
    expect(contracts(c.provides)).toEqual([
      "GET /api/orders/{id} - -> OrderDto",
      "POST /api/orders OrderDto -> OrderDto",
      "PUT /api/orders/{id}/cancel - -> -",
    ]);
    const dir = "src/main/java/com/example/orders/api";
    expect(dtos(c)).toEqual([
      `record OrderDto(id: String, lines: List<OrderLine>, status: OrderStatus, total: BigDecimal) ${dir}/OrderDto.java:6`,
      `class OrderLine(sku: String, quantity: int) ${dir}/OrderLine.java:6`,
      `enum OrderStatus(NEW, PAID, CANCELLED) ${dir}/OrderStatus.java:3`,
    ]);
  });

  test("payments: kontroler Javy odpowiada data class Kotlina", () => {
    expect(dtos(card(fixtureFiles("payments")))).toEqual([
      "data-class Payment(orderId: String, amount: java.math.BigDecimal?) src/main/java/com/example/payments/Payment.kt:3",
    ]);
  });

  test("kontroler Kotlina: @RequestBody z argumentami, suspend, ResponseEntity i funkcja bez jawnego typu", () => {
    const c = card({
      "src/main/kotlin/a/OrdersController.kt": [
        "@RestController",
        '@RequestMapping("/orders")',
        "class OrdersController {",
        '    @PostMapping("/{id}")',
        "    suspend fun create(@PathVariable id: Long, @RequestBody(required = false) body: CreateOrder): ResponseEntity<OrderDto> = TODO()",
        "",
        "    @GetMapping",
        "    fun list() = repo.all()",
        "}",
        "",
        "data class CreateOrder(val sku: String, val quantity: Int)",
        "",
        "class OrderDto(val id: String, note: String) {",
        "    var status: Status = Status.NEW",
        "}",
        "",
        "enum class Status { NEW, PAID }",
      ].join("\n"),
    });
    expect(contracts(c.provides)).toEqual(["POST /orders/{id} CreateOrder -> OrderDto", "GET /orders - -> -"]);
    expect(dtos(c)).toEqual([
      "data-class CreateOrder(sku: String, quantity: Int) src/main/kotlin/a/OrdersController.kt:11",
      "class OrderDto(id: String, status: Status) src/main/kotlin/a/OrdersController.kt:13",
      "enum Status(NEW, PAID) src/main/kotlin/a/OrdersController.kt:17",
    ]);
  });

  test("metoda z interfejsu API, który kontroler implementuje, ma kontrakt z pliku interfejsu", () => {
    const c = card({
      "src/main/java/a/OrdersApi.java": [
        '@RequestMapping("/orders")',
        "public interface OrdersApi {",
        "  @PostMapping Mono<ResponseEntity<List<OrderDto>>> create(@Valid @org.springframework.web.bind.annotation.RequestBody Flux<CreateOrder> body);",
        "}",
      ].join("\n"),
      "src/main/java/a/OrdersController.java": "@RestController public class OrdersController implements OrdersApi {}",
    });
    expect(contracts(c.provides)).toEqual(["POST /orders Flux<CreateOrder> -> List<OrderDto>"]);
  });

  test("odpowiedź bez opakowań, które nie zmieniają treści, i bez treści dla void, Unit i ResponseEntity<Void>", () => {
    expect(responseType("ResponseEntity<OrderDto>")).toBe("OrderDto");
    expect(responseType("Mono<ResponseEntity<Map<String, OrderDto>>>")).toBe("Map<String,OrderDto>");
    expect(responseType("org.springframework.http.ResponseEntity<OrderDto>")).toBe("OrderDto");
    expect(responseType("Flux<OrderDto>")).toBe("Flux<OrderDto>");
    expect(responseType("CompletableFuture<Optional<OrderDto>>")).toBe("OrderDto");
    expect(responseType("void")).toBeNull();
    expect(responseType("Unit")).toBeNull();
    expect(responseType("ResponseEntity<Void>")).toBeNull();
    expect(responseType("ResponseEntity<?>")).toBeNull();
    expect(responseType(null)).toBeNull();
  });

  test("DTO zagnieżdżone w kontrolerze i typ o nazwie innej niż plik są na karcie; typ spoza repo nie", () => {
    const c = card({
      "src/main/java/a/Api.java": [
        "@RestController class Api {",
        '  @GetMapping("/a") public Page<Summary> a() { return null; }',
        "  public static class Summary { private String name; private Detail detail; }",
        "}",
      ].join("\n"),
      "src/main/java/a/Models.java": "class Models {}\nclass Detail { private long id; }",
    });
    expect(dtos(c)).toEqual([
      "class Summary(name: String, detail: Detail) src/main/java/a/Api.java:3",
      "class Detail(id: long) src/main/java/a/Models.java:2",
    ]);
  });

  test("plik, którego parsowanie przekracza limit, jest problemem karty, a endpoint zostaje bez typów", () => {
    const c = card({
      "src/main/kotlin/a/Api.kt": `@RestController\nclass Api {\n    @GetMapping("/a")\n    fun a(): OrderDto = TODO()\n}\n${"fun f() = a<".repeat(20_000)}`,
    });
    expect(contracts(c.provides)).toEqual(["GET /a - -> -"]);
    expect(c.problems).toEqual([
      {
        path: "src/main/kotlin/a/Api.kt",
        message: "parsing the file took longer than 1000 ms; its endpoints and types are missing from contracts",
      },
    ]);
  });
  test("po przekroczeniu łącznego czasu parsowania karty kolejne pliki zostają bez kontraktów, z jednym problemem", () => {
    const snapshot = snapshotOf({
      "src/main/java/a/A.java": '@RestController class A { @GetMapping("/a") public Dto a() { return null; } }',
      "src/main/java/a/B.java": '@RestController class B { @GetMapping("/b") public Dto b() { return null; } }',
    });
    const { provides, problems } = extractContracts(snapshot, extractCard(snapshot, parsers).provides, parsers, 0);
    expect(contracts(provides)).toEqual(["GET /a - -> Dto", "GET /b - -> -"]);
    expect(problems).toEqual([
      {
        path: "",
        message:
          "parsing Java and Kotlin took longer than 0 ms; the remaining endpoints have no request and response types and the DTO list is incomplete",
      },
    ]);
  });
});

describe("odczyt plików typów, które wymienia kod HTTP", () => {
  test("odczyt dociąga pliki o nazwach typów z kontrolera i z nich, najwyżej trzy rundy, bez plików testów", async () => {
    const source = (path: string) => ({ name: path.split("/").pop() ?? path, path, kind: "file" as const, size: 10 });
    const texts: Record<string, string> = {
      "src/main/java/a/Api.java": "@RestController class Api { @GetMapping OrderDto get() { return null; } }",
      "src/main/java/a/OrderDto.java": "record OrderDto(Line line) {}",
      "src/main/java/a/Line.java": "class Line { Sku sku; }",
      "src/main/java/a/Sku.java": "class Sku { Code code; }",
      "src/main/java/a/Code.java": "class Code {}",
      "src/test/java/a/OrderDto.java": "record OrderDto() {}",
    };
    const requested: string[][] = [];
    const vcs = {
      commitFiles: async () => ({ files: Object.keys(texts).map(source), truncated: false }),
      readFiles: async (_dir: string, _commit: string, paths: readonly string[]) => {
        requested.push([...paths]);
        return new Map(paths.map((p) => [p, Buffer.from(texts[p] ?? "")]));
      },
      grepFiles: async () => ({ paths: ["src/main/java/a/Api.java"], truncated: false }),
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), () => false, CARD_SOURCES);
    expect(requested).toEqual([
      ["src/main/java/a/Api.java"],
      ["src/main/java/a/OrderDto.java"],
      ["src/main/java/a/Line.java"],
      ["src/main/java/a/Sku.java"],
    ]);
    expect(snapshot.text("src/main/java/a/Code.java")).toBeUndefined();
    expect(snapshot.problems).toEqual([]);
  });
});
