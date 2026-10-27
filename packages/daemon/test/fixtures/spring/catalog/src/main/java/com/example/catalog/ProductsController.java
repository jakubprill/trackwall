package com.example.catalog;

import com.example.catalog.api.ProductsApi;
import com.example.catalog.model.NewProduct;
import com.example.catalog.model.Product;
import com.example.catalog.model.StockLevel;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

// ProductsApi, with the mappings, is generated from openapi/catalog.yaml into target/ during the build (interfaceOnly).
@RestController
@RequestMapping("/api")
public class ProductsController implements ProductsApi {
  @Override
  public ResponseEntity<Product> getProduct(String productId) {
    return ResponseEntity.ok(new Product().id(productId));
  }

  @Override
  public ResponseEntity<Product> createProduct(NewProduct product) {
    return ResponseEntity.status(201).body(new Product().id(product.getName()));
  }

  @Override
  public ResponseEntity<List<StockLevel>> getProductStock(String productId) {
    return ResponseEntity.ok(List.of());
  }
}
