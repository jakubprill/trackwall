package com.example.checkout;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ShippingTest {

    @Test
    void addsTheFlatRate() {
        assertEquals(17, Shipping.withShipping(12));
    }
}
