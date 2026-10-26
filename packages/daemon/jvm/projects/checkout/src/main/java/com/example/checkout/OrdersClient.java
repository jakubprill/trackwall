package com.example.checkout;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class OrdersClient {

    private final RestClient client;

    public OrdersClient(RestClient.Builder builder, @Value("${orders.url}") String baseUrl) {
        this.client = builder.baseUrl(baseUrl).build();
    }

    public OrderDto get(String id) {
        return client.get().uri("/api/orders/{id}", id).retrieve().body(OrderDto.class);
    }
}
