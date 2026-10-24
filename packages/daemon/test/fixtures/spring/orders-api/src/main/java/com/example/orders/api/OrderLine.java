package com.example.orders.api;

import lombok.Data;

@Data
public class OrderLine {
    private static final long serialVersionUID = 1L;

    private String sku;
    private int quantity;
}
