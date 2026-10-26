package com.example.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PricingTest {

    @Test
    void multipliesQuantityByUnitPrice() {
        assertEquals(12, Pricing.total(3, 4));
    }

    @Test
    void costsNothingWithoutItems() {
        assertEquals(0, Pricing.total(0, 4));
    }
}
