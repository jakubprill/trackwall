import { describe, expect, test } from "bun:test";
import { httpMethodMatches, httpPathMatches, joinHttpPath, parseHttpUrl, withoutCredentials } from "../src/http.ts";

describe("adresy i ścieżki HTTP", () => {
  test("adres rozkłada się na schemat, host małymi literami, port i ścieżkę bez zapytania", () => {
    expect(parseHttpUrl("HTTP://Orders-API.shop.svc:8080/api/v1?x=1")).toEqual({
      scheme: "http",
      host: "orders-api.shop.svc",
      port: 8080,
      path: "/api/v1",
    });
    expect(parseHttpUrl("lb://payments")).toEqual({ scheme: "lb", host: "payments", port: null, path: "" });
  });

  test(`tekst, który nie jest adresem, i host z nierozwiniętym \${...} nie są adresem`, () => {
    expect(parseHttpUrl("orders-api")).toBeUndefined();
    expect(parseHttpUrl("ftp://files")).toBeUndefined();
    expect(parseHttpUrl(`http://\${ORDERS_HOST}/api`)).toBeUndefined();
    expect(parseHttpUrl(`http://${"a".repeat(3000)}`)).toBeUndefined();
  });

  test("adres traci użytkownika, hasło i zapytanie, zanim trafi na kartę, a host i port zostają", () => {
    expect(withoutCredentials("https://ja:tajne@orders.example.com:8443/api?apiKey=x#a")).toBe("https://***@orders.example.com:8443/api");
    expect(parseHttpUrl("https://***@orders.example.com:8443/api")).toEqual({
      scheme: "https",
      host: "orders.example.com",
      port: 8443,
      path: "/api",
    });
    expect(withoutCredentials("http://orders/api")).toBe("http://orders/api");
  });

  test("hasło z @, ? albo # i token w ścieżce nie przechodzą przez maskowanie, a adres IPv6 ma host i port", () => {
    expect(withoutCredentials("http://ja:p@ss@orders/api")).toBe("http://***@orders/api");
    expect(withoutCredentials("http://ja:pa#ss@orders/api")).toBe("http://***@orders/api");
    expect(withoutCredentials("https://hooks.example.com/services/T000/B000/XXXXSECRET1234567890ab")).toBe(
      "https://hooks.example.com/services/T000/B000/***",
    );
    expect(withoutCredentials("http://orders:8080/api/v1/orders/{id}")).toBe("http://orders:8080/api/v1/orders/{id}");
    expect(withoutCredentials("http://orders/customer-service-v2-api/getOrdersByCustomerId2")).toBe(
      "http://orders/customer-service-v2-api/getOrdersByCustomerId2",
    );
    expect(withoutCredentials("http://example.com?email=a@b.com")).toBe("http://example.com");
    expect(parseHttpUrl("http://example.com?email=a@b.com")?.host).toBe("example.com");
    expect(parseHttpUrl("http://ja:p@ss@orders/x")?.host).toBe("orders");
    expect(parseHttpUrl("http://[::1]:8090/api")).toEqual({ scheme: "http", host: "[::1]", port: 8090, path: "/api" });
    expect(withoutCredentials("http://ja:p/ss@orders/api")).toBe("http://***@orders/api");
    expect(parseHttpUrl("http://ja:p/ss@orders/api")?.host).toBe("orders");
    expect(withoutCredentials("http://orders:8080/users/@me")).toBe("http://orders:8080/users/@me");
    expect(parseHttpUrl("http://orders#a@evil/x")?.host).toBe("orders");
    expect(withoutCredentials("http://ja:p/s?s@orders/x")).toBe("http://***");
    expect(withoutCredentials("http://ja:pa ss@orders/x")).toBe("http://***");
    expect(withoutCredentials("http://[::1]:8080/users/@me")).toBe("http://[::1]:8080/users/@me");
    expect(withoutCredentials(`http://localhost:\${PORT}/users/@me`)).toBe(`http://localhost:\${PORT}/users/@me`);
  });

  test("ścieżki sklejają się z jednym ukośnikiem między częściami", () => {
    expect(joinHttpPath("/ctx/", "api", "/orders/", "{id}?full=true")).toBe("/ctx/api/orders/{id}");
    expect(joinHttpPath("", "")).toBe("/");
  });

  test("zmienna z każdej strony pasuje do jednego członu, a ** w endpoincie do reszty ścieżki", () => {
    expect(httpPathMatches("/api/orders/42", "/api/orders/{id}")).toBe(true);
    expect(httpPathMatches("/api/orders/{}", "/api/orders/{id}")).toBe(true);
    expect(httpPathMatches("/api/orders/42/cancel", "/api/orders/{id}")).toBe(false);
    expect(httpPathMatches("/api/orders", "/api/orders/{id}")).toBe(false);
    expect(httpPathMatches("/static/js/app.js", "/static/**")).toBe(true);
    expect(httpPathMatches("/api/<ApiPaths.ORDERS>", "/api/orders")).toBe(false);
  });

  test("metoda null z którejś strony pasuje do każdej metody", () => {
    expect(httpMethodMatches("GET", "GET")).toBe(true);
    expect(httpMethodMatches("GET", "POST")).toBe(false);
    expect(httpMethodMatches(null, "POST")).toBe(true);
    expect(httpMethodMatches("DELETE", null)).toBe(true);
  });
});
