package com.example.checkout;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/checkout")
public class CheckoutController {

    private final OrdersClient orders;

    public CheckoutController(OrdersClient orders) {
        this.orders = orders;
    }

    @GetMapping("/{orderId}")
    public CheckoutDto checkout(@PathVariable String orderId) {
        OrderDto order = orders.get(orderId);
        return new CheckoutDto(order.id(), Shipping.withShipping(order.total()));
    }
}
