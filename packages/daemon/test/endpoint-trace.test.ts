import { describe, expect, test } from "bun:test";
import type { ConsumedHttp, ProvidedEndpoint } from "@trackwall/protocol";
import { type CallFile, readJavaCalls } from "../src/modules/cards/call-index-java.ts";
import { CallIndex, traceClosure, traceEndpoints } from "../src/modules/cards/endpoint-trace.ts";
import { extractSpring } from "../src/modules/cards/spring.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { snapshotOf } from "./support/snapshot.ts";

// SPIKE (issue #120): what the bounded endpoint trace reaches, and the patterns it is known to miss.

const parsers = await loadSyntaxParsers();
const dir = "src/main/java/com/example/shop";

function reached(files: Record<string, string>): Record<string, string[]> {
  const facts = extractSpring(snapshotOf(files));
  const endpoints = facts.provides.filter((p): p is ProvidedEndpoint => p.kind === "endpoint");
  const clients = facts.consumes.filter((c): c is ConsumedHttp => c.kind === "http");
  const callFiles = Object.entries(files).flatMap(([path, text]): CallFile[] => {
    const read = parsers.read("java", text, (root) => readJavaCalls(path, root));
    return read.kind === "parsed" ? [read.value] : [];
  });
  const index = new CallIndex(callFiles);
  const bounded = traceEndpoints(endpoints, clients, index);
  const closure = traceClosure(endpoints, clients, index, 8).traces;
  const out: Record<string, string[]> = {};
  bounded.forEach((t, i) => {
    const calls = t.calls.map((c) => `${c.client} ${c.call.method} ${c.call.path}`).sort();
    const fromClosure = (closure[i]?.calls ?? []).map((c) => `${c.client} ${c.call.method} ${c.call.path}`).sort();
    expect(fromClosure).toEqual(calls);
    out[t.endpoint] = calls;
  });
  return out;
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

describe("endpoint trace (spike)", () => {
  test("follows fields, interface implementations, superclass fields, lambdas and method references to the client calls", () => {
    const result = reached({
      [`${dir}/clients/PaymentsClient.java`]: PAYMENTS_CLIENT,
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/OrderService.java`]: `package com.example.shop;
public interface OrderService { String place(String sku); void cancel(String id); }`,
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
    expect(result).toEqual({
      "POST /orders": ["PaymentsClient POST /payments", "StockClient POST /reservations"],
      "DELETE /orders/{id}": [],
    });
  });

  test("misses a client reached through a `var` from a method call, an event listener, and a client chosen at run time", () => {
    const result = reached({
      [`${dir}/clients/PaymentsClient.java`]: PAYMENTS_CLIENT,
      [`${dir}/clients/StockClient.java`]: STOCK_CLIENT,
      [`${dir}/Clients.java`]: `package com.example.shop;
import com.example.shop.clients.StockClient;
public class Clients { public StockClient stock() { return null; } }`,
      [`${dir}/OnOrderPlaced.java`]: `package com.example.shop;
import com.example.shop.clients.PaymentsClient;
@Component
public class OnOrderPlaced {
  private PaymentsClient payments;
  @EventListener public void on(String id) { payments.status(id); }
}`,
      [`${dir}/StockController.java`]: `package com.example.shop;
@RestController
public class StockController {
  private final Clients clients;
  private final ApplicationEventPublisher events;
  @GetMapping("/stock/{sku}") public int level(@PathVariable String sku) { var stock = clients.stock(); return stock.level(sku); }
  @GetMapping("/stock-direct/{sku}") public int direct(@PathVariable String sku) { return clients.stock().level(sku); }
  @PostMapping("/orders/{id}/placed") public void placed(@PathVariable String id) { events.publishEvent(id); }
}`,
    });
    expect(result).toEqual({
      // `var` from a method call: the reader keeps only `var x = new T()`.
      "GET /stock/{sku}": [],
      "GET /stock-direct/{sku}": ["StockClient GET /levels/{sku}"],
      // Spring calls the listener, not the code: no static path.
      "POST /orders/{id}/placed": [],
    });
  });
});
