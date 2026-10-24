package com.example.bff

import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody

@FeignClient(name = "orders-api", url = "\${clients.orders.url}")
interface OrdersClient {
    @GetMapping("/api/orders/{id}")
    fun get(@PathVariable id: String): OrderDto

    @PostMapping("/api/orders")
    fun create(@RequestBody order: OrderDto): OrderDto
}
