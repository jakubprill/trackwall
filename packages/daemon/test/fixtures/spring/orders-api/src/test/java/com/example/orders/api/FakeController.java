package com.example.orders.api;

import org.springframework.web.bind.annotation.*;

/** Kontroler tylko do testów: nie jest częścią aplikacji. */
@RestController
class FakeController {
    @GetMapping("/test-only")
    String ping() { return "pong"; }
}
