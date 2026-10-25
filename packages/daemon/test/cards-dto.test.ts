import { describe, expect, test } from "bun:test";
import type { ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { extractContracts, responseType } from "../src/modules/cards/endpoint-contracts.ts";
import { CARD_SOURCES, extractCard } from "../src/modules/cards/extract-card.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
import { loadSyntaxParsers, unavailableParsers, withParseBudget } from "../src/modules/cards/syntax-tree.ts";
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
  return c.dtos.map((d) => {
    const members = d.kind === "enum" ? d.values : d.fields.map((f) => `${f.name}: ${f.type}`);
    return `${d.kind} ${d.name}(${members.join(", ")}) ${d.evidence.path}:${d.evidence.line}`;
  });
}

describe("endpoint contracts and DTOs", () => {
  test("orders-api: request and response types and DTOs from a record, a Lombok class and an enum, without static fields", () => {
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

  test("payments: a Java controller answers with a Kotlin data class", () => {
    expect(dtos(card(fixtureFiles("payments")))).toEqual([
      "data-class Payment(orderId: String, amount: java.math.BigDecimal?) src/main/java/com/example/payments/Payment.kt:3",
    ]);
  });

  test("a Kotlin controller: @RequestBody with arguments, suspend, ResponseEntity and a function without an explicit type", () => {
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

  test("a method from an API interface the controller implements has the contract from the interface file", () => {
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

  test("the response without wrappers that do not change the content, and no content for void, Unit and ResponseEntity<Void>", () => {
    expect(responseType("ResponseEntity<OrderDto>")).toBe("OrderDto");
    expect(responseType("ResponseEntity<OrderDto>?")).toBe("OrderDto");
    expect(responseType("Mono<ResponseEntity<Map<String,OrderDto>>>")).toBe("Map<String,OrderDto>");
    expect(responseType("org.springframework.http.ResponseEntity<OrderDto>")).toBe("OrderDto");
    expect(responseType("Flux<OrderDto>")).toBe("Flux<OrderDto>");
    expect(responseType("CompletableFuture<Optional<OrderDto>>")).toBe("OrderDto");
    expect(responseType("void")).toBeNull();
    expect(responseType("Unit")).toBeNull();
    expect(responseType("ResponseEntity<Void>")).toBeNull();
    expect(responseType("ResponseEntity<?>")).toBeNull();
    expect(responseType("ResponseEntity<*>")).toBeNull();
    expect(responseType("ResponseEntity")).toBeNull();
    expect(responseType(null)).toBeNull();
  });

  test("a DTO nested in the controller and a type named differently from its file are on the card; a type from outside the repo is not", () => {
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

  test("a file whose parsing exceeds the limit is a card problem, and the endpoint stays without types", () => {
    const c = card({
      "src/main/kotlin/a/Api.kt": `@RestController\nclass Api {\n    @GetMapping("/a")\n    fun a(): OrderDto = TODO()\n}\n${"fun f() = a<".repeat(20_000)}`,
    });
    expect(contracts(c.provides)).toEqual(["GET /a - -> -"]);
    expect(c.problems).toEqual([
      {
        path: "src/main/kotlin/a/Api.kt",
        message: "parsing the file took longer than 1000 ms; its endpoints have no request and response types and its DTOs are missing",
      },
    ]);
  });

  test("after the card's total parse time is exceeded the files stay without contracts, with one problem", () => {
    const snapshot = snapshotOf({
      "src/main/java/a/A.java": '@RestController class A { @GetMapping("/a") public Dto a() { return null; } }',
      "src/main/java/a/B.java": '@RestController class B { @GetMapping("/b") public Dto b() { return null; } }',
    });
    const budgeted = withParseBudget(parsers, 0);
    const { provides, problems } = extractContracts(snapshot, extractCard(snapshot, parsers).provides, budgeted);
    expect(contracts(provides)).toEqual(["GET /a - -> -", "GET /b - -> -"]);
    expect(budgeted.complete).toBe(false);
    expect(problems).toEqual([
      {
        path: "",
        message:
          "parsing Java and Kotlin took longer than 0 ms; the remaining endpoints have no request and response types and the DTO list is incomplete",
      },
    ]);
  });

  test("a card without parsers is complete as long as it does not try to parse any file", () => {
    const parsersOfCard = withParseBudget(unavailableParsers("grammar missing"), 10_000);
    expect(parsersOfCard.complete).toBe(true);
    expect(parsersOfCard.read("java", "class A {}", () => 1)).toEqual({ kind: "unavailable", reason: "grammar missing" });
    expect(parsersOfCard.complete).toBe(false);
  });

  test("without parsers the card is built without contracts and DTOs, with one problem", () => {
    const c = extractCard(snapshotOf(fixtureFiles("orders-api")), unavailableParsers("grammar missing"));
    expect(contracts(c.provides)).toEqual(["GET /api/orders/{id} - -> -", "POST /api/orders - -> -", "PUT /api/orders/{id}/cancel - -> -"]);
    expect(c.dtos).toEqual([]);
    expect(c.problems).toEqual([
      {
        path: "",
        message:
          "Java and Kotlin parsers could not be loaded (grammar missing); endpoints have no request and response types and the card has no DTOs",
      },
    ]);
  });

  test("the contract is the method containing the mapping, not the first method with that name in the file", () => {
    const c = card({
      "src/main/java/a/Api.java": [
        "@RestController class Api {",
        "  private Helper create(String s) { return null; }",
        '  @PostMapping("/a") OrderDto create(@RequestBody OrderIn body) { return null; }',
        '  @PostMapping("/b") OrderDto create(@RequestBody OtherIn body, int x) { return null; }',
        "}",
        "@RestController class Second {",
        '  @GetMapping("/c") PaymentDto create() { return null; }',
        "}",
      ].join("\n"),
    });
    expect(contracts(c.provides)).toEqual(["POST /a OrderIn -> OrderDto", "POST /b OtherIn -> OrderDto", "GET /c - -> PaymentDto"]);
  });

  test("a qualified type points to a DTO by its last part, and a class without fields (a service) is not a DTO", () => {
    const c = card({
      "src/main/kotlin/a/Api.kt": [
        "@RestController",
        "class Api(private val service: OrderService) {",
        '    @GetMapping("/a")',
        "    fun a(): ResponseEntity<Api.Summary>? = null",
        "    data class Summary(val name: String)",
        "}",
        "class OrderService(repo: OrderRepository)",
      ].join("\n"),
    });
    expect(contracts(c.provides)).toEqual(["GET /a - -> Api.Summary"]);
    expect(dtos(c)).toEqual(["data-class Summary(name: String) src/main/kotlin/a/Api.kt:5"]);
  });

  test("the type notation has no annotations, a space only between words, and array dimensions at the field name", () => {
    const c = card({
      "src/main/java/a/Api.java": [
        "@RestController class Api {",
        '  @PostMapping("/a") ResponseEntity<@Valid OrderDto> a(@RequestBody Map<String,   List<? extends @NotNull Line>> body) { return null; }',
        "}",
        "class OrderDto { int a, b[]; }",
      ].join("\n"),
    });
    expect(contracts(c.provides)).toEqual(["POST /a Map<String,List<? extends Line>> -> OrderDto"]);
    expect(dtos(c)).toEqual(["class OrderDto(a: int, b: int[]) src/main/java/a/Api.java:4"]);
  });

  test("an enum with over 200 constants is truncated, and an empty record is not a DTO", () => {
    const constants = Array.from({ length: 201 }, (_, i) => `C${i}`).join(", ");
    const c = card({
      "src/main/java/a/Api.java": `@RestController class Api { @GetMapping("/a") Many a(@RequestBody Empty body) { return null; } }\nenum Many { ${constants} }\nrecord Empty() {}`,
    });
    expect(c.dtos.map((d) => (d.kind === "enum" ? `${d.name}: ${d.values.length}` : d.name))).toEqual(["Many: 200"]);
    expect(c.problems).toEqual([
      { path: "src/main/java/a/Api.java", message: "Many has more than 200 constants; the card lists the first ones" },
    ]);
  });

  test("two mappings on one line have the contracts of their own methods", () => {
    const c = card({
      "src/main/java/a/Api.java":
        '@RestController class Api { @GetMapping("/a") public A a() { return null; } @PostMapping("/b") public B b(@RequestBody X x) { return null; } }',
    });
    expect(contracts(c.provides)).toEqual(["GET /a - -> A", "POST /b X -> B"]);
  });

  test("a DTO with over 200 fields and types longer than 256 characters are truncated, with a problem", () => {
    const fields = Array.from({ length: 201 }, (_, i) => `String f${i};`).join(" ");
    const long = `Map<${"A".repeat(300)},String>`;
    const c = card({
      "src/main/java/a/Api.java": `@RestController class Api { @GetMapping("/a") Wide a(@RequestBody ${long} body) { return null; } }\nclass Wide { ${fields} }`,
    });
    const endpoint = c.provides.find((p) => p.kind === "endpoint");
    expect(endpoint?.kind === "endpoint" ? endpoint.request : null).toBe(`${long.slice(0, 256)}…`);
    const wide = c.dtos[0];
    expect(wide?.kind === "class" ? wide.fields.length : 0).toBe(200);
    expect(c.problems).toEqual([
      { path: "src/main/java/a/Api.java", message: "Wide has more than 200 fields; the card lists the first ones" },
      { path: "", message: "some types are longer than 256 characters; the card shows their beginning" },
    ]);
  });
});

describe("reading the type files the HTTP code mentions", () => {
  test("the read fetches files named after types from the controller and from them, at most three rounds, without test files", async () => {
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
    expect([...snapshot.typeFiles]).toEqual(["src/main/java/a/OrderDto.java", "src/main/java/a/Line.java", "src/main/java/a/Sku.java"]);
    expect(snapshot.problems).toEqual([]);
  });

  test("type files that did not fit in the read limit give one problem instead of a problem per file", async () => {
    const source = (path: string) => ({ name: path.split("/").pop() ?? path, path, kind: "file" as const, size: 10 });
    const paths = ["src/main/java/a/Api.java", "src/main/java/a/OrderDto.java", "src/main/java/a/Line.java"];
    const vcs = {
      commitFiles: async () => ({ files: paths.map(source), truncated: false }),
      // The byte limit is used up after the first file: further reads give nothing.
      readFiles: async (_dir: string, _commit: string, wanted: readonly string[]) =>
        new Map(
          wanted.includes("src/main/java/a/Api.java")
            ? [["src/main/java/a/Api.java", Buffer.from("class Api { OrderDto a; Line b; }")]]
            : [],
        ),
      grepFiles: async () => ({ paths: ["src/main/java/a/Api.java"], truncated: false }),
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), () => false, CARD_SOURCES);
    expect(snapshot.problems).toEqual([
      {
        path: "",
        message:
          "2 type files referenced from HTTP code were not read (at most 3000 files within the 67108864 B commit read limit); their DTOs are missing",
      },
    ]);
  });

  test("a type file fetched for contracts gives no HTTP facts, even when it looks like a controller", () => {
    const files = {
      "src/main/java/a/Api.java": '@RestController class Api { @GetMapping("/a") OrderDto a() { return null; } }',
      "src/main/java/a/OrderDto.java": '@RestController class OrderDto { String id; @GetMapping("/b") void b() {} }',
    };
    const snapshot = { ...snapshotOf(files), typeFiles: new Set(["src/main/java/a/OrderDto.java"]) };
    const c = extractCard(snapshot, parsers);
    expect(contracts(c.provides)).toEqual(["GET /a - -> OrderDto"]);
    expect(dtos(c)).toEqual(["class OrderDto(id: String) src/main/java/a/OrderDto.java:1"]);
  });

  test("a file from the search that did not fit in the read limit does not come back as a type file", async () => {
    const source = (path: string) => ({ name: path.split("/").pop() ?? path, path, kind: "file" as const, size: 10 });
    const paths = ["src/main/java/a/OrdersController.java", "src/main/java/a/OrdersApi.java"];
    let reads = 0;
    const vcs = {
      commitFiles: async () => ({ files: paths.map(source), truncated: false }),
      // The first read fits only the controller; the next ones would return everything.
      readFiles: async (_dir: string, _commit: string, wanted: readonly string[]) => {
        const first = reads++ === 0;
        const texts = new Map([
          ["src/main/java/a/OrdersController.java", "@RestController class OrdersController implements OrdersApi {}"],
        ]);
        if (!first) texts.set("src/main/java/a/OrdersApi.java", "interface OrdersApi {}");
        return new Map(wanted.flatMap((p) => (texts.has(p) ? [[p, Buffer.from(texts.get(p) ?? "")]] : [])));
      },
      grepFiles: async () => ({ paths, truncated: false }),
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), () => false, CARD_SOURCES);
    expect([...snapshot.typeFiles]).toEqual([]);
    expect(snapshot.problems).toEqual([
      { path: "src/main/java/a/OrdersApi.java", message: "the file was not read within the 67108864 B commit read limit" },
    ]);
  });
});
