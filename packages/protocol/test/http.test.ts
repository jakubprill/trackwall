import { describe, expect, test } from "bun:test";
import {
  httpMethodMatches,
  httpPathMatches,
  httpUrlPath,
  joinHttpPath,
  parseHttpUrl,
  withoutCredentials,
  withoutCredentialsInText,
} from "../src/http.ts";

describe("HTTP addresses and paths", () => {
  test("the path of an address loses the scheme, host, query and fragment, and a bare path only its query", () => {
    expect(
      ["https://gateway.example.com:8443/orders/api?x=1", "lb://orders/api", "http://u:p/w@host/v1#top", "/api/v1?x", "http://host"].map(
        httpUrlPath,
      ),
    ).toEqual(["/orders/api", "/api", "/v1", "/api/v1", ""]);
  });

  test("an address splits into scheme, lowercase host, port and path without the query", () => {
    expect(parseHttpUrl("HTTP://Orders-API.shop.svc:8080/api/v1?x=1")).toEqual({
      scheme: "http",
      host: "orders-api.shop.svc",
      port: 8080,
      path: "/api/v1",
    });
    expect(parseHttpUrl("lb://payments")).toEqual({ scheme: "lb", host: "payments", port: null, path: "" });
  });

  test(`text that is not an address, and a host with an unexpanded \${...}, are not an address`, () => {
    expect(parseHttpUrl("orders-api")).toBeUndefined();
    expect(parseHttpUrl("ftp://files")).toBeUndefined();
    expect(parseHttpUrl(`http://\${ORDERS_HOST}/api`)).toBeUndefined();
    expect(parseHttpUrl(`http://${"a".repeat(3000)}`)).toBeUndefined();
  });

  test("an address loses the user, password and query before it reaches the card, and the host and port stay", () => {
    expect(withoutCredentials("https://me:secret@orders.example.com:8443/api?apiKey=x#a")).toBe("https://***@orders.example.com:8443/api");
    expect(parseHttpUrl("https://***@orders.example.com:8443/api")).toEqual({
      scheme: "https",
      host: "orders.example.com",
      port: 8443,
      path: "/api",
    });
    expect(withoutCredentials("http://orders/api")).toBe("http://orders/api");
  });

  test.each([
    ["jdbc:postgresql://shop:pw@db:5432/shop?password=pw", "jdbc:postgresql://***@db:5432/shop"],
    ["a=http://u:p1@h/x, b=http://v:p2@h2/y", "a=http://***@h/x, b=http://***@h2/y"],
    ["jdbc:oracle:thin:scott/tiger@//db:1521/orders", "jdbc:oracle:thin:***@//db:1521/orders"],
    ["redis://:pw@cache:6379", "redis://***@cache:6379"],
    ["no address here", "no address here"],
  ])("every address in text loses its credentials: %s", (text, masked) => {
    expect(withoutCredentialsInText(text)).toBe(masked);
  });

  test("a password with @, ? or # and a token in the path do not slip through the masking, and an IPv6 address has a host and port", () => {
    expect(withoutCredentials("http://me:p@ss@orders/api")).toBe("http://***@orders/api");
    expect(withoutCredentials("http://me:pa#ss@orders/api")).toBe("http://***@orders/api");
    expect(withoutCredentials("https://hooks.example.com/services/T000/B000/XXXXSECRET1234567890ab")).toBe(
      "https://hooks.example.com/services/T000/B000/***",
    );
    expect(withoutCredentials("http://orders:8080/api/v1/orders/{id}")).toBe("http://orders:8080/api/v1/orders/{id}");
    expect(withoutCredentials("http://orders/customer-service-v2-api/getOrdersByCustomerId2")).toBe(
      "http://orders/customer-service-v2-api/getOrdersByCustomerId2",
    );
    expect(withoutCredentials("http://example.com?email=a@b.com")).toBe("http://example.com");
    expect(parseHttpUrl("http://example.com?email=a@b.com")?.host).toBe("example.com");
    expect(parseHttpUrl("http://me:p@ss@orders/x")?.host).toBe("orders");
    expect(parseHttpUrl("http://[::1]:8090/api")).toEqual({ scheme: "http", host: "[::1]", port: 8090, path: "/api" });
    expect(withoutCredentials("http://me:p/ss@orders/api")).toBe("http://***@orders/api");
    expect(parseHttpUrl("http://me:p/ss@orders/api")?.host).toBe("orders");
    expect(withoutCredentials("http://orders:8080/users/@me")).toBe("http://orders:8080/users/@me");
    expect(parseHttpUrl("http://orders#a@evil/x")?.host).toBe("orders");
    expect(withoutCredentials("http://me:p/s?s@orders/x")).toBe("http://***");
    expect(withoutCredentials("http://me:pa ss@orders/x")).toBe("http://***");
    expect(withoutCredentials("http://[::1]:8080/users/@me")).toBe("http://[::1]:8080/users/@me");
    expect(withoutCredentials(`http://localhost:\${PORT}/users/@me`)).toBe(`http://localhost:\${PORT}/users/@me`);
  });

  test("paths join with one slash between the parts", () => {
    expect(joinHttpPath("/ctx/", "api", "/orders/", "{id}?full=true")).toBe("/ctx/api/orders/{id}");
    expect(joinHttpPath("", "")).toBe("/");
  });

  test("a variable on either side matches one segment, and ** in the endpoint the rest of the path", () => {
    expect(httpPathMatches("/api/orders/42", "/api/orders/{id}")).toBe(true);
    expect(httpPathMatches("/api/orders/{}", "/api/orders/{id}")).toBe(true);
    expect(httpPathMatches("/api/orders/42/cancel", "/api/orders/{id}")).toBe(false);
    expect(httpPathMatches("/api/orders", "/api/orders/{id}")).toBe(false);
    expect(httpPathMatches("/static/js/app.js", "/static/**")).toBe(true);
    expect(httpPathMatches("/api/<ApiPaths.ORDERS>", "/api/orders")).toBe(false);
  });

  test("a null method on either side matches any method", () => {
    expect(httpMethodMatches("GET", "GET")).toBe(true);
    expect(httpMethodMatches("GET", "POST")).toBe(false);
    expect(httpMethodMatches(null, "POST")).toBe(true);
    expect(httpMethodMatches("DELETE", null)).toBe(true);
  });
});
