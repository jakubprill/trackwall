package com.example.checkout;

public final class Shipping {
    static final int FLAT_RATE = 5;

    private Shipping() {}

    public static int withShipping(int total) {
        return total + FLAT_RATE;
    }
}
