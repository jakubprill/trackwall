# Fixture'y Spring dla kart i grafu (ADR-30)

Pięć zmyślonych repo sklepu, na których testy sprawdzają ekstraktory HTTP, kontrakty endpointów z DTO (ADR-38) i
krawędzie `http`:

- `orders-api`: aplikacja `orders-api` (port 8081) z kontrolerem zamówień; ścieżki ze stałych `ApiPaths`; DTO
  `OrderDto` (rekord) z polami typów `OrderLine` (klasa Lomboka z polem `static`) i `OrderStatus` (enum).
- `orders-bff`: klient Feign do `orders-api` z adresem z konfiguracji (inny w profilu `prod`) i `WebClient` do
  `payments-service` z adresem z `@Value`.
- `payments`: aplikacja `payments-service` w `application.properties` z dokumentem profilu `#---` i DTO `Payment`
  (`data class`).
- `legacy-reports`: `RestTemplate` z adresem bazowym spoza konfiguracji (graf łączy go po samych ścieżkach).
- `shop-web`: frontend z `VITE_API_URL` i proxy Vite do `orders-bff` na `localhost:8090`.

To dane, nie kod Trackwall: knip ich nie sprawdza (`ignore` w `knip.json`), bo `vite.config.mjs` frontendu nie ma
importera.
