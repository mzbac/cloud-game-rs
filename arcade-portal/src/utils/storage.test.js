import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  safeLocalStorageGetItem,
  safeLocalStorageSetItem,
  writeJsonToLocalStorage,
} from "./storage";

describe("storage helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("safeLocalStorageSetItem writes and returns true", () => {
    expect(safeLocalStorageSetItem("k", "v")).toBe(true);
    expect(window.localStorage.getItem("k")).toBe("v");
  });

  it("safeLocalStorageGetItem returns null for missing keys", () => {
    expect(safeLocalStorageGetItem("missing")).toBeNull();
  });

  it("safeLocalStorageGetItem returns null on storage errors", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = vi.fn(() => {
      throw new Error("blocked");
    });
    expect(safeLocalStorageGetItem("k")).toBeNull();
    window.localStorage.getItem = original;
  });

  it("writeJsonToLocalStorage serializes values", () => {
    expect(writeJsonToLocalStorage("obj", { a: 1 })).toBe(true);
    expect(window.localStorage.getItem("obj")).toBe('{"a":1}');
  });
});

