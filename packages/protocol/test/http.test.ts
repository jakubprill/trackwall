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
