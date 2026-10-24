package com.example.reports;

import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;

public class OrdersReport {

    private final RestTemplate restTemplate;
    private final String ordersUrl;

    public OrdersReport(RestTemplate restTemplate, String ordersUrl) {
        this.restTemplate = restTemplate;
        this.ordersUrl = ordersUrl;
    }

    public OrderDto order(String id) {
        return restTemplate.getForObject(ordersUrl + "/api/orders/" + id, OrderDto.class);
    }

    public void cancel(String id) {
        restTemplate.exchange(ordersUrl + "/api/orders/" + id + "/cancel", HttpMethod.PUT, null, Void.class);
    }
}
