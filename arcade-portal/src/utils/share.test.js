import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("antd", () => ({
  message: {
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { message } from "antd";
import { copyTextToClipboard, shareUrl } from "./share";

describe("share helpers", () => {
  const originalClipboard = navigator.clipboard;
  const originalShare = navigator.share;
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    message.success.mockClear();
    message.info.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: undefined, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    Object.defineProperty(navigator, "share", { value: originalShare, configurable: true });
    Object.defineProperty(document, "execCommand", { value: originalExecCommand, configurable: true });
  });

  describe("copyTextToClipboard", () => {
    it("returns false when text is empty", async () => {
      await expect(copyTextToClipboard("")).resolves.toBe(false);
      await expect(copyTextToClipboard(null)).resolves.toBe(false);
    });

    it("uses navigator.clipboard when available", async () => {
      const writeText = vi.fn().mockResolvedValue();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      await expect(copyTextToClipboard("hello")).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith("hello");
    });

    it("falls back to execCommand copy when clipboard fails", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("nope"));
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      const execCommand = vi.fn(() => true);
      Object.defineProperty(document, "execCommand", {
        value: execCommand,
        configurable: true,
      });

      await expect(copyTextToClipboard("hello")).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(document.querySelector("textarea")).toBeNull();
    });
  });

  describe("shareUrl", () => {
    it("uses navigator.share when available", async () => {
      const share = vi.fn().mockResolvedValue();
      Object.defineProperty(navigator, "share", {
        value: share,
        configurable: true,
      });

      await shareUrl({ title: "t", url: "https://example.com" });
      expect(share).toHaveBeenCalledWith({ title: "t", url: "https://example.com" });
      expect(message.success).not.toHaveBeenCalled();
      expect(message.info).not.toHaveBeenCalled();
    });

    it("falls back to clipboard copy + toast when share is blocked", async () => {
      const share = vi.fn().mockRejectedValue(new Error("blocked"));
      Object.defineProperty(navigator, "share", {
        value: share,
        configurable: true,
      });
      const writeText = vi.fn().mockResolvedValue();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      await shareUrl({ title: "t", url: "https://example.com" });
      expect(message.success).toHaveBeenCalledWith("Link copied");
    });

    it("falls back to showing the URL when copy fails", async () => {
      await shareUrl({ title: "t", url: "https://example.com" });
      expect(message.info).toHaveBeenCalledWith("https://example.com");
    });
  });
});

