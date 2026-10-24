package com.example.payments

data class Payment(
    val orderId: String,
    val amount: java.math.BigDecimal? = null,
)
