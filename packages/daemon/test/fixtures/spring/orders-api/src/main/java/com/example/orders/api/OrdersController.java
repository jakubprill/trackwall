package com.example.orders.api;

import org.springframework.web.bind.annotation.*;

/**
 * Orders. The old endpoint is disabled:
 * @GetMapping("/legacy")
 */
@RestController
@RequestMapping(ApiPaths.ORDERS)
public class OrdersController {

    private final OrderService service;

    public OrdersController(OrderService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable("id") String id) {
        if (id.isBlank()) {
            throw new IllegalArgumentException("brak id: {}");
        }
        return service.find(id);
    }

    @PostMapping
    public OrderDto create(@RequestBody OrderDto order) {
        return service.create(order);
    }

    // @DeleteMapping("/{id}") — deleting comes back in the next release
    @RequestMapping(value = "/{id}/cancel", method = RequestMethod.PUT)
    public void cancel(@PathVariable String id) {
        service.cancel(id);
    }
}
