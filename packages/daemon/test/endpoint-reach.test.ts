import { describe, expect, test } from "bun:test";
import type { ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { MAX_DISPATCH } from "../src/modules/cards/call-graph.ts";
import type { CallFile } from "../src/modules/cards/call-types.ts";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { readJavaCalls } from "../src/modules/cards/java-calls.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { snapshotOf } from "./support/snapshot.ts";

const parsers = await loadSyntaxParsers();
const dir = "src/main/java/com/example/shop";

/** The card of these files, with every Java file read for the endpoint reach. */
function card(files: Record<string, string>): RepoCard {
  const callFiles = Object.entries(files)
    .filter(([path]) => path.endsWith(".java"))
    .map(([path, text]): CallFile => {
      const read = parsers.read("java", text, readJavaCalls);
      if (read.kind !== "parsed") throw new Error(`${path} did not parse`);
      return { path, calls: read.value };
    });
  return extractCard(snapshotOf(files), parsers, { files: callFiles, problems: [], complete: true });
}

/** Each endpoint with the calls it reaches, as `<client> <method> <path>`; `null` without a reach. */
function reaches(c: RepoCard): Record<string, string[] | null> {
  const endpoints = c.provides.filter((p): p is ProvidedEndpoint => p.kind === "endpoint");
  return Object.fromEntries(
    endpoints.map((e) => [`${e.method} ${e.path}`, e.reaches?.map((r) => `${r.client} ${r.method} ${r.path}`) ?? null]),
  );
}

const PAYMENTS_CLIENT = `package com.example.shop.clients;
import org.springframework.cloud.openfeign.FeignClient;
@FeignClient(name = "payments")
public interface PaymentsClient {
  @PostMapping("/payments") String pay(String order);
  @GetMapping("/payments/{id}") String status(String id);
}`;

const STOCK_CLIENT = `package com.example.shop.clients;
@Component
public class StockClient {
  private final RestTemplate rest;
  public int reserve(String sku) { return rest.postForObject("http://stock/reservations", sku, Integer.class); }
  public int level(String sku) { return rest.getForObject("http://stock/levels/{sku}", Integer.class, sku); }
}`;

describe("endpoint reach (ADR-82)", () => {
  test("follows fields, interface implementations, superclass fields, lambdas and method references to client calls", () => {
    const c = card({
      [`${dir}/clients/PaymentsClient.java`]: PAYMENTS_CLIENT,
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/OrderService.java`]:
        "package com.example.shop;\npublic interface OrderService { String place(String sku); void cancel(String id); }",
      [`${dir}/BaseService.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public abstract class BaseService { protected StockClient stock; }`,
      [`${dir}/OrderServiceImpl.java`]: `package com.example.shop;
import com.example.shop.clients.PaymentsClient;
@Service
public class OrderServiceImpl extends BaseService implements OrderService {
  private final PaymentsClient payments;
  public String place(String sku) {
    java.util.List.of(sku).forEach(s -> stock.reserve(s));
    return charge(sku);
  }
  private String charge(String sku) { return java.util.Optional.of(sku).map(payments::pay).orElseThrow(); }
  public void cancel(String id) { }
}`,
      [`${dir}/OrderController.java`]: `package com.example.shop;
@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderService orders;
  @PostMapping public String place(@RequestBody String sku) { return orders.place(sku); }
  @DeleteMapping("/{id}") public void cancel(@PathVariable String id) { orders.cancel(id); }
}`,
    });
    expect(c.reachTraced).toBe(true);
    expect(reaches(c)).toEqual({
      "POST /orders": ["PaymentsClient POST /payments", "StockClient POST /reservations"],
      "DELETE /orders/{id}": [],
    });
    const place = c.provides.find((p): p is ProvidedEndpoint => p.kind === "endpoint" && p.method === "POST");
    expect(place?.reaches?.map((r) => [r.via, `${r.evidence.path}:${r.evidence.line}`])).toEqual([
      ["feign", `${dir}/clients/PaymentsClient.java:5`],
      ["rest-template", `${dir}/clients/StockClient.java:5`],
    ]);
  });

  test("follows a `var` set from a call and a chain of calls by their return types", () => {
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/Clients.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public class Clients { public StockClient stock() { return null; } }`,
      [`${dir}/StockController.java`]: `package com.example.shop;
@RestController
public class StockController {
  private final Clients clients;
  @GetMapping("/stock/{sku}") public int level(@PathVariable String sku) { var stock = clients.stock(); return stock.level(sku); }
  @PostMapping("/stock/{sku}") public int reserve(@PathVariable String sku) { return clients.stock().reserve(sku); }
}`,
    });
    expect(reaches(c)).toEqual({
      "GET /stock/{sku}": ["StockClient GET /levels/{sku}"],
      "POST /stock/{sku}": ["StockClient POST /reservations"],
    });
  });

  test("a call made only by an event listener or a scheduled job is reached by no endpoint", () => {
    const c = card({
      [`${dir}/clients/PaymentsClient.java`]: PAYMENTS_CLIENT,
      [`${dir}/OnOrderPlaced.java`]: `package com.example.shop;
import com.example.shop.clients.PaymentsClient;
@Component
public class OnOrderPlaced {
  private PaymentsClient payments;
  @EventListener public void on(String id) { payments.status(id); }
  @Scheduled(cron = "0 0 * * * *") public void retry() { payments.pay("x"); }
}`,
      [`${dir}/OrderController.java`]: `package com.example.shop;
@RestController
public class OrderController {
  private final ApplicationEventPublisher events;
  @PostMapping("/orders/{id}/placed") public void placed(@PathVariable String id) { events.publishEvent(id); }
}`,
    });
    expect(reaches(c)).toEqual({ "POST /orders/{id}/placed": [] });
  });

  test(`a call on a type with more than ${MAX_DISPATCH} implementations is not followed, one with fewer reaches each of them`, () => {
    const handlers = (count: number, prefix: string) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `${dir}/${prefix}${i}.java`,
          `package com.example.shop;
import com.example.shop.clients.StockClient;
public class ${prefix}${i} implements ${prefix} { private StockClient stock; public int handle(String sku) { return stock.level(sku); } }`,
        ]),
      );
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/Few.java`]: "package com.example.shop;\npublic interface Few { int handle(String sku); }",
      [`${dir}/Many.java`]: "package com.example.shop;\npublic interface Many { int handle(String sku); }",
      ...handlers(2, "Few"),
      ...handlers(MAX_DISPATCH + 1, "Many"),
      [`${dir}/Api.java`]: `package com.example.shop;
@RestController
public class Api {
  private Few few;
  private Many many;
  @GetMapping("/few") public int few() { return few.handle("a"); }
  @GetMapping("/many") public int many() { return many.handle("a"); }
}`,
    });
    expect(reaches(c)).toEqual({ "GET /few": ["StockClient GET /levels/{sku}"], "GET /many": [] });
  });

  test("an import decides between two types with one name, so a local service is not taken for a client of the same name", () => {
    const c = card({
      "client/src/main/java/com/example/search/client/SearchService.java": `package com.example.search.client;
@FeignClient(name = "search")
public interface SearchService { @PostMapping("/search") String query(String q); }`,
      "server/src/main/java/com/example/search/SearchService.java": `package com.example.search;
@Service
public class SearchService { public String query(String q) { return q; } }`,
      "server/src/main/java/com/example/search/SearchController.java": `package com.example.search;
@RestController
public class SearchController {
  private SearchService search;
  @GetMapping("/search") public String search(String q) { return search.query(q); }
}`,
      "logs/src/main/java/com/example/logs/LogController.java": `package com.example.logs;
import com.example.search.client.SearchService;
@RestController
public class LogController {
  private SearchService search;
  @GetMapping("/logs") public String logs(String q) { return search.query(q); }
}`,
    });
    expect(reaches(c)).toEqual({ "GET /search": [], "GET /logs": ["SearchService POST /search"] });
  });

  test("methods calling each other in a cycle reach the calls of the whole cycle", () => {
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/Walker.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public class Walker {
  private StockClient stock;
  public int even(int n) { return n == 0 ? stock.level("e") : odd(n - 1); }
  public int odd(int n) { return n == 0 ? stock.reserve("o") : even(n - 1); }
}`,
      [`${dir}/Api.java`]: `package com.example.shop;
@RestController
public class Api {
  private Walker walker;
  @GetMapping("/walk") public int walk() { return walker.odd(3); }
}`,
    });
    expect(reaches(c)).toEqual({ "GET /walk": ["StockClient POST /reservations", "StockClient GET /levels/{sku}"] });
  });

  test(`a base class with more than ${MAX_DISPATCH} subclasses still runs its own methods, which reach their calls`, () => {
    const subclasses = Object.fromEntries(
      Array.from({ length: MAX_DISPATCH + 1 }, (_, i) => [
        `${dir}/Report${i}.java`,
        `package com.example.shop;\npublic class Report${i} extends BaseReport { }`,
      ]),
    );
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/BaseReport.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public abstract class BaseReport {
  private StockClient stock;
  public int build() { return fetch(); }
  protected int fetch() { return stock.level("all"); }
}`,
      ...subclasses,
      [`${dir}/Api.java`]: `package com.example.shop;
@RestController
public class Api {
  private Report0 report;
  @GetMapping("/report") public int report() { return report.build(); }
}`,
    });
    expect(reaches(c)).toEqual({ "GET /report": ["StockClient GET /levels/{sku}"] });
  });

  test("a client whose address differs by profile is one call in the reach", () => {
    const c = card({
      "src/main/resources/application.yml": "payments:\n  url: http://payments.local\n",
      "src/main/resources/application-prod.yml": "payments:\n  url: http://payments.prod\n",
      [`${dir}/clients/PaymentsClient.java`]: `package com.example.shop.clients;
@FeignClient(name = "payments", url = "\${payments.url}")
public interface PaymentsClient { @GetMapping("/payments/{id}") String status(String id); }`,
      [`${dir}/Api.java`]: `package com.example.shop;
import com.example.shop.clients.PaymentsClient;
@RestController
public class Api {
  private PaymentsClient payments;
  @GetMapping("/orders/{id}/payment") public String payment(@PathVariable String id) { return payments.status(id); }
}`,
    });
    expect(c.consumes.filter((x) => x.kind === "http")).toHaveLength(2);
    expect(reaches(c)).toEqual({ "GET /orders/{id}/payment": ["PaymentsClient GET /payments/{id}"] });
  });

  test("an overload with the call's argument count in a superclass wins over one with another count in the subclass", () => {
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/Base.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public class Base { protected StockClient stock; public int count(String sku, int min) { return stock.level(sku); } }`,
      [`${dir}/Child.java`]: `package com.example.shop;
public class Child extends Base { public int count(String sku) { return stock.reserve(sku); } }`,
      [`${dir}/Api.java`]: `package com.example.shop;
@RestController
public class Api {
  private Child child;
  @GetMapping("/count") public int count() { return child.count("a", 1); }
}`,
    });
    expect(reaches(c)).toEqual({ "GET /count": ["StockClient GET /levels/{sku}"] });
  });

  test("follows an imported nested type, an enum's methods, a typed lambda parameter and a caught exception", () => {
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/clients/Clients.java`]: `package com.example.shop.clients;
public class Clients { public interface Stock { int level(String sku); } }`,
      [`${dir}/clients/StockImpl.java`]: `package com.example.shop.clients;
public class StockImpl implements Clients.Stock { private StockClient stock; public int level(String sku) { return stock.level(sku); } }`,
      [`${dir}/Mode.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public enum Mode {
  FAST, SLOW;
  private StockClient stock;
  public int reserve(String sku) { return stock.reserve(sku); }
}`,
      [`${dir}/Failure.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public class Failure extends RuntimeException { private StockClient stock; public int report() { return stock.level("failed"); } }`,
      [`${dir}/Api.java`]: `package com.example.shop;
import com.example.shop.clients.Clients.Stock;
@RestController
public class Api {
  private Stock stock;
  @GetMapping("/nested") public int nested() { return stock.level("a"); }
  @GetMapping("/enum") public int byEnum() { return java.util.stream.Stream.of("a").mapToInt((String s) -> modeOf(s).reserve(s)).sum(); }
  @GetMapping("/caught") public int caught() { try { return 1; } catch (Failure e) { return e.report(); } }
  private Mode modeOf(String s) { return Mode.FAST; }
}`,
    });
    expect(reaches(c)).toEqual({
      "GET /nested": ["StockClient GET /levels/{sku}"],
      "GET /enum": ["StockClient POST /reservations"],
      "GET /caught": ["StockClient GET /levels/{sku}"],
    });
  });

  test("two endpoints on overloads of one handler name each reach only their own overload's calls", () => {
    const c = card({
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/Api.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
@RestController
public class Api {
  private StockClient stock;
  @GetMapping("/levels/{sku}") public int get(@PathVariable String sku) { return stock.level(sku); }
  @PostMapping("/levels") public int get(@RequestBody String sku, @RequestParam int n) { return stock.reserve(sku); }
}`,
    });
    expect(reaches(c)).toEqual({
      "GET /levels/{sku}": ["StockClient GET /levels/{sku}"],
      "POST /levels": ["StockClient POST /reservations"],
    });
  });

  test("without call files the card did not trace, and every endpoint is without a reach", () => {
    const c = extractCard(
      snapshotOf({ [`${dir}/Api.java`]: '@RestController public class Api { @GetMapping("/a") public int a() { return 1; } }' }),
      parsers,
      { files: null, problems: [], complete: true },
    );
    expect(c.reachTraced).toBe(false);
    expect(reaches(c)).toEqual({ "GET /a": null });
  });
});
