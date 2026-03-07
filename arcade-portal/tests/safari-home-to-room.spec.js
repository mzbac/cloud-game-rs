import { test, expect } from "playwright/test";

test("webkit can enter a room from home without a manual refresh", async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".gameCard").first()).toBeVisible();

  await page.locator(".gameCard").first().click();
  await expect(page).toHaveURL(/\/game\//);
  await expect(page.locator(".GameHeader__name")).not.toHaveText("");

  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return Boolean(video && video.videoWidth > 0 && video.readyState >= 2);
  });

  expect(
    consoleErrors.filter((message) => message.includes("WebSocket connection to"))
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
});
