package com.example.reports;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class OrdersReportService implements ReportService {

    private final OrdersReport orders;

    public OrdersReportService(OrdersReport orders) {
        this.orders = orders;
    }

    @Override
    public OrderDto orderReport(String id) {
        return orders.order(id);
    }

    @Scheduled(cron = "0 0 3 * * *")
    public void cancelStale() {
        orders.cancel("stale");
    }
}
