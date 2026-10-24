package com.example.payments;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/payments")
public class PaymentsController {

    @PostMapping("/{orderId}")
    public Payment pay(@PathVariable String orderId) {
        return new Payment(orderId);
    }
}
