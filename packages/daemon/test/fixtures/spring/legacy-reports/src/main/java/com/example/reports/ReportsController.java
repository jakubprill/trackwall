package com.example.reports;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ReportsController {

    private final ReportService reports;

    public ReportsController(ReportService reports) {
        this.reports = reports;
    }

    @GetMapping("/reports/orders/{id}")
    public OrderDto order(@PathVariable String id) {
        return reports.orderReport(id);
    }
}
