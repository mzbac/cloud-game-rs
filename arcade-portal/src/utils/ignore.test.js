import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log", () => ({
  logWarn: vi.fn(),
}));

import { ignorePromiseRejection } from "./ignore";
import { logWarn } from "./log";

describe("ignorePromiseRejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs rejected promises with context", async () => {
    const err = new Error("boom");
    ignorePromiseRejection(Promise.reject(err), "ctx");
    await Promise.resolve();
    expect(logWarn).toHaveBeenCalledWith("ctx", err);
  });

  it("does nothing for non-promises", () => {
    ignorePromiseRejection(null, "ctx");
    expect(logWarn).not.toHaveBeenCalled();
  });
});
