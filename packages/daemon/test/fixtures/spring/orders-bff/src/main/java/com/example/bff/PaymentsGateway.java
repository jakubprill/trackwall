package com.example.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

@Component
public class PaymentsGateway {

    private final WebClient client;

    public PaymentsGateway(WebClient.Builder builder, @Value("${clients.payments.base-url}") String baseUrl) {
        this.client = builder.baseUrl(baseUrl).build();
    }

    public Mono<Payment> pay(String orderId) {
        return client.post()
            .uri("/payments/{orderId}", orderId)
            .retrieve()
            .bodyToMono(Payment.class);
    }
}
