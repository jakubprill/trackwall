# Spring fixtures for cards and the graph (ADR-30)

Six made-up shop repos on which the tests check the HTTP extractors, endpoint contracts with DTOs (ADR-38) and
`http` edges:

- `orders-api`: the `orders-api` app (port 8081) with an orders controller; paths from `ApiPaths` constants; the DTO
  `OrderDto` (a record) with fields of types `OrderLine` (a Lombok class with a `static` field) and `OrderStatus` (an enum).
- `orders-bff`: a Feign client to `orders-api` with an address from configuration (different in the `prod` profile) and a
  `WebClient` to `payments-service` with an address from `@Value`.
- `payments`: the `payments-service` app in `application.properties` with a `#---` profile document and the DTO `Payment`
  (a `data class`).
- `legacy-reports`: a `RestTemplate` with a base address from outside the configuration (the graph links it by paths alone),
  a controller that reaches its `order` call through a service interface, and a scheduled job that alone makes the
  `cancel` call (the endpoint reach, ADR-82).
- `catalog`: the `catalog` app (context path `/catalog`) whose `ProductsController` (mapped to `/api`) implements
  `ProductsApi`, an interface the build generates from `openapi/catalog.yaml` with `interfaceOnly` and which is not in the
  repo, so its endpoints come from the spec (ADR-87); `CategoriesController` maps a path with `${catalog.api-prefix}`, and the build generates a client from
  `openapi/orders-api.yaml`, whose operation is not a catalog endpoint.
- `shop-web`: a frontend with `VITE_API_URL` and a Vite proxy to `orders-bff` on `localhost:8090`.

This is data, not Trackwall code: knip does not check it (`ignore` in `knip.json`), because the frontend's `vite.config.mjs`
has no importer.
