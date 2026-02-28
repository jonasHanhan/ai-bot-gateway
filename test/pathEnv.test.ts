import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parsePathListEnv } from "../src/utils/pathEnv.js";

describe("path env parsing", () => {
  test("returns empty array for blank values", () => {
    expect(parsePathListEnv(undefined)).toEqual([]);
    expect(parsePathListEnv("")).toEqual([]);
    expect(parsePathListEnv("   ")).toEqual([]);
  });

  test("parses colon-separated entries and resolves to absolute paths", () => {
    const parsed = parsePathListEnv("./one: ./two :/tmp/three");
    expect(parsed).toEqual([path.resolve("./one"), path.resolve("./two"), path.resolve("/tmp/three")]);
  });
});
