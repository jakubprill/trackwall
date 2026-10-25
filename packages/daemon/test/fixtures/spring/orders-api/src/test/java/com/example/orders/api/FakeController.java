package com.example.orders.api;

import org.springframework.web.bind.annotation.*;

/** A controller for tests only: not part of the app. */
@RestController
class FakeController {
    @GetMapping("/test-only")
    String ping() { return "pong"; }
}
