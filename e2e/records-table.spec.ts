import { expect, test } from "@playwright/test";

test.describe("UAP records table", () => {
  test.beforeEach(async ({ page }) => {
    // Set up the index-fetch wait BEFORE navigating so we don't miss the
    // response. We don't await it here — only tests that exercise full-text
    // search need to block on it.
    const indexResponse = page.waitForResponse(
      (r) => r.url().endsWith("/text-index.json") && r.ok(),
      { timeout: 30_000 },
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("UAP / UFO releases");
    await indexResponse;
  });

  test("renders all records on first load", async ({ page }) => {
    const summary = page.locator("text=/Showing \\d+ of \\d+ records/");
    await expect(summary).toBeVisible();
    const text = (await summary.textContent()) ?? "";
    const m = text.match(/Showing (\d+) of (\d+) records/);
    expect(m).not.toBeNull();
    const [, shown, total] = m!;
    expect(Number(shown)).toBe(Number(total));
    expect(Number(total)).toBeGreaterThanOrEqual(100);
  });

  test("typing a term filters rows live", async ({ page }) => {
    const before = await page.locator("table tbody tr").count();
    await page.locator('input[placeholder*="Search"]').fill("FBI");
    await expect
      .poll(() => page.locator("table tbody tr").count(), { timeout: 5_000 })
      .toBeLessThan(before);
    await expect(page.locator("text=/Showing \\d+ of/")).not.toContainText(
      `Showing ${before} of`,
    );
  });

  test("Enter promotes the term to a removable chip", async ({ page }) => {
    const input = page.locator('input[placeholder*="Search"]');
    await input.fill("NASA");
    await input.press("Enter");
    // Chip is rendered with the term + a × button
    const chip = page.locator("span", { hasText: /^NASA×$/ });
    await expect(chip).toBeVisible();
    // Input cleared
    await expect(page.locator('input[placeholder*="Add another"]')).toBeVisible();
    // Removing the chip restores all rows
    const filteredCount = await page.locator("table tbody tr").count();
    await chip.locator("button").click();
    await expect
      .poll(() => page.locator("table tbody tr").count(), { timeout: 5_000 })
      .toBeGreaterThan(filteredCount);
  });

  test("multiple chips AND together", async ({ page }) => {
    const input = page.locator('input[placeholder*="Search"]');
    await input.fill("FBI");
    await input.press("Enter");
    const fbiOnly = await page.locator("table tbody tr").count();
    await page.locator('input[placeholder*="Add another"]').fill("Section");
    await page.locator('input[placeholder*="Add another"]').press("Enter");
    await expect
      .poll(() => page.locator("table tbody tr").count(), { timeout: 5_000 })
      .toBeLessThanOrEqual(fbiOnly);
  });

  test("Backspace on empty input removes the last chip", async ({ page }) => {
    const input = page.locator('input[placeholder*="Search"]');
    await input.fill("State");
    await input.press("Enter");
    await expect(page.locator("span", { hasText: /^State×$/ })).toBeVisible();
    const after = page.locator('input[placeholder*="Add another"]');
    await after.focus();
    await after.press("Backspace");
    await expect(page.locator("span", { hasText: /^State×$/ })).toHaveCount(0);
  });

  test('"Include removed" checkbox only renders when there are removed records', async ({ page }) => {
    // Currently no records removed from source, so the checkbox should be absent.
    await expect(page.getByLabel("Include removed")).toHaveCount(0);
  });

  test("clicking a row expands the modal with the AI-transcription banner", async ({ page }) => {
    const firstRow = page.locator("table tbody tr").first();
    await firstRow.click();
    await expect(
      page.getByText(/AI-transcribed text|Extracted text not available/),
    ).toBeVisible();
  });

  test("external file links open war.gov / dvidshub", async ({ page }) => {
    const links = page.locator('table tbody a[href*="war.gov"], table tbody a[href*="dvidshub"]');
    const count = await links.count();
    expect(count).toBeGreaterThan(10);
    const href = await links.first().getAttribute("href");
    expect(href).toMatch(/^https:\/\/(www\.war\.gov|www\.dvidshub\.net)\//);
  });
});
