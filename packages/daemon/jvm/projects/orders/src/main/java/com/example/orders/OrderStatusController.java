package com.example.orders;

import com.example.orders.api.OrderStatusApi;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

// OrderStatusApi, with the mapping, is generated from src/main/resources/openapi/orders.yaml into target/ by the build.
@RestController
public class OrderStatusController implements OrderStatusApi {

    @Override
    public ResponseEntity<String> getOrderStatus(String id) {
        return ResponseEntity.ok("shipped");
    }
}
