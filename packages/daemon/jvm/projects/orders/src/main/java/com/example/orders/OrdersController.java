package com.example.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrdersController {

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable String id) {
        return new OrderDto(id, Pricing.total(3, 4));
    }
}
