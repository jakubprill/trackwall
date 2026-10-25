// The agent turns of the demo sessions (`copilot.ts`): what each repo's session was asked, did and answered. The
// answers match the demo shop's graph (`workspace.ts`), so a screenshot never shows an agent contradicting it.

type Ending = "working" | "waiting" | "approval";

export interface Turn {
  prompt: string;
  steps: string[];
  answer: string[];
  ending: Ending;
}

/** The turn each repo shows; the demo starts a session in every repo that has one. */
export const TURNS: Record<string, Turn> = {
  "orders-api": {
    prompt: "Retry a failed payment twice before the order is cancelled",
    steps: [
      "Read src/main/java/com/example/shop/ordersapi/clients/PaymentsClient.java",
      "Read src/main/resources/application.yml",
      "Edit src/main/java/com/example/shop/ordersapi/OrdersController.java (+18 -3)",
    ],
    answer: [],
    ending: "approval",
  },
  payments: {
    prompt: "Who calls POST /api/payments and what do they send?",
    steps: ["trackwall-who_calls payments", "trackwall-find_endpoint POST /api/payments"],
    answer: ["Two repos call it: orders-api and shop-bff.", "All of them send PaymentsDto with an order id and an amount in cents."],
    ending: "waiting",
  },
  "shop-web": {
    prompt: "Add a checkout summary with the delivery estimate from shipping",
    steps: ["Read src/Checkout.tsx", "trackwall-subgraph_for shop-web", "Edit src/Checkout.tsx (+42)"],
    answer: [],
    ending: "working",
  },
  catalog: {
    prompt: "Why does the product page show stale prices?",
    steps: ["trackwall-get_errors catalog", "Read src/main/java/com/example/shop/catalog/clients/PricingClient.java"],
    answer: [
      "The pricing client caches answers for an hour; pricing changes every 15 minutes.",
      "Shorten the cache to 5 minutes, or listen to price-changed events?",
    ],
    ending: "waiting",
  },
  inventory: {
    prompt: "Run the tests and fix what fails",
    steps: ["trackwall-run_mise_task inventory build"],
    answer: [],
    ending: "approval",
  },
  search: {
    prompt: "Index reviews together with products",
    steps: [
      "Read src/main/java/com/example/shop/search/clients/ReviewsClient.java",
      "Edit src/main/java/com/example/shop/search/SearchController.java (+27 -4)",
    ],
    answer: [],
    ending: "working",
  },
  "api-gateway": {
    prompt: "List the routes that have no rate limit",
    steps: ["Read src/main/resources/application.yml", "trackwall-subgraph_for api-gateway"],
    answer: ["Five routes go out without a limit: /api/products, /api/orders, /api/customers, /api/search and /api/tokens."],
    ending: "waiting",
  },
  "admin-bff": {
    prompt: "Start admin-bff with its dependencies and check GET /api/admin",
    steps: ["trackwall-start_service admin-bff", "trackwall-call_endpoint GET /api/admin/42"],
    answer: [],
    ending: "working",
  },
  shipping: {
    prompt: "Rename ShipmentsDto.eta to estimatedDelivery everywhere it is used",
    steps: ["trackwall-search_code ShipmentsDto", "Edit 4 files"],
    answer: ["Renamed in shipping and in admin-bff, its only caller."],
    ending: "waiting",
  },
};
