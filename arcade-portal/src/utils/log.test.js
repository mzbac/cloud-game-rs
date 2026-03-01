import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { logError, logInfo, logWarn } from "./log";

describe("log helpers", () => {
  const isDev = import.meta?.env ? Boolean(import.meta.env.DEV) : process.env.NODE_ENV !== "production";

  let infoSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logInfo respects dev mode", () => {
    logInfo("hello", { a: 1 });
    if (isDev) {
      expect(infoSpy).toHaveBeenCalledWith("hello", { a: 1 });
    } else {
      expect(infoSpy).not.toHaveBeenCalled();
    }
  });

  it("logWarn respects dev mode", () => {
    logWarn("hello");
    if (isDev) {
      expect(warnSpy).toHaveBeenCalledWith("hello");
    } else {
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it("logError respects dev mode", () => {
    logError("hello");
    if (isDev) {
      expect(errorSpy).toHaveBeenCalledWith("hello");
    } else {
      expect(errorSpy).not.toHaveBeenCalled();
    }
  });
});

