import { describe, expect, test } from "bun:test";
import { segmentsBelow } from "../src/lib/host-folder.ts";

describe("a repo's place below the projects folder", () => {
  test("is the folder names after the projects folder", () => {
    expect(segmentsBelow("/workspaces", "/workspaces/orders-api")).toEqual(["orders-api"]);
    expect(segmentsBelow("/workspaces/", "/workspaces/shop/orders-api/")).toEqual(["shop", "orders-api"]);
  });

  test("is nothing for the projects folder itself or a folder outside it", () => {
    expect(segmentsBelow("/workspaces", "/workspaces")).toBeUndefined();
    expect(segmentsBelow("/workspaces", "/workspaces-old/orders-api")).toBeUndefined();
    expect(segmentsBelow("/workspaces", "/home/vscode/orders-api")).toBeUndefined();
    expect(segmentsBelow("", "/orders-api")).toBeUndefined();
  });

  test("is nothing for a path that climbs out of it", () => {
    expect(segmentsBelow("/workspaces", "/workspaces/../etc")).toBeUndefined();
  });
});
