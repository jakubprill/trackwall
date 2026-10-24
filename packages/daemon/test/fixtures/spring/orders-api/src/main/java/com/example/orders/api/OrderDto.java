package com.example.orders.api;

import java.math.BigDecimal;
import java.util.List;

public record OrderDto(String id, List<OrderLine> lines, OrderStatus status, BigDecimal total) {}
