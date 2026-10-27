package com.example.catalog;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CategoriesController {
  @GetMapping("${catalog.api-prefix}/categories")
  public List<String> listCategories() {
    return List.of("books", "games");
  }
}
