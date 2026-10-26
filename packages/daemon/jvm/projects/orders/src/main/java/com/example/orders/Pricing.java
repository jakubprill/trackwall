package com.example.orders;

public final class Pricing {
    private Pricing() {}

    public static int total(int quantity, int unitPrice) {
        return quantity * unitPrice;
    }
}
