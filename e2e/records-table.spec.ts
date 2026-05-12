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

  test("renders all live records on first load", async ({ page }) => {
    const summary = page.locator("text=/Showing \\d+ of \\d+ records/");
    await expect(summary).toBeVisible();
    const text = (await summary.textContent()) ?? "";
    const m = text.match(/Showing (\d+) of (\d+) records/);
    expect(m).not.toBeNull();
    const [, shown, total] = m!;
    // Archived records are hidden by default, so shown ≤ total.
    expect(Number(shown)).toBeLessThanOrEqual(Number(total));
    expect(Number(shown)).toBeGreaterThanOrEqual(100);
    expect(Number(total)).toBeGreaterThanOrEqual(Number(shown));
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

  test('"Include removed" checkbox renders iff there are removed records', async ({ page }) => {
    // Read the "Showing X of Y" summary — when X < Y the checkbox should
    // be present, otherwise absent.
    const text =
      (await page.locator("text=/Showing \\d+ of \\d+ records/").textContent()) ?? "";
    const m = text.match(/Showing (\d+) of (\d+) records/);
    const hasArchived = m ? Number(m[1]) < Number(m[2]) : false;
    const checkbox = page.getByLabel("Include removed");
    if (hasArchived) {
      await expect(checkbox).toHaveCount(1);
    } else {
      await expect(checkbox).toHaveCount(0);
    }
  });

  test("clicking a row expands the modal with the extraction banner", async ({ page }) => {
    // Click the chevron cell (1st col) — avoids hitting tag chips inside the row.
    await page.locator("table tbody tr:first-child td:first-child").click();
    await expect(
      page.getByText(
        /AI-transcribed text|Extracted text \(pdftotext\)|Extracted text not available/,
      ),
    ).toBeVisible();
  });

  test("Agency facet narrows results when a checkbox is selected", async ({ page }) => {
    const before = await page.locator("table tbody tr").count();
    // Open the Agency facet popover
    await page.locator("summary", { hasText: /^Agency/ }).first().click();
    // Each option's accessible name is "<value> <count>"
    await page.getByRole("checkbox", { name: /FBI \d+/ }).check();
    await expect
      .poll(() => page.locator("table tbody tr").count(), { timeout: 5_000 })
      .toBeLessThan(before);
    // Summary now shows the count
    await expect(page.locator("summary", { hasText: /Agency \(1\)/ })).toBeVisible();
  });

  test("/mirror lists every R2 URL grouped by type", async ({ page }) => {
    await page.goto("/mirror");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("R2 mirror");
    await expect(page.getByRole("heading", { level: 2, name: /^PDFs/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /^Images/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /^Videos/ })).toBeVisible();
    const r2Links = page.locator(
      'a[href^="https://pub-a5fc1ae0b89944dba0ab60286076ab1e.r2.dev/"]',
    );
    expect(await r2Links.count()).toBeGreaterThan(150);
  });

  test("Tags column renders chips on each row", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    const firstTag = page.locator("table tbody span[class*='font-mono']").first();
    await firstTag.scrollIntoViewIfNeeded();
    const tagText = ((await firstTag.textContent()) ?? "").trim();
    expect(tagText.length).toBeGreaterThan(0);
  });

  test("mobile viewport hides Agency/Incident/Location columns and inlines them under the title", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    // Header columns: only the chevron, Type, Title, Action remain visible
    await expect(page.getByRole("columnheader", { name: /^Agency$/ })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: /^Location$/ })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: /^Incident$/ })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: /^Title$/ })).toBeVisible();
    // Rows still render and the Open link still shows
    expect(await page.locator("table tbody tr").count()).toBeGreaterThan(0);
    await expect(page.locator('table tbody a[href*="war.gov"]').first()).toBeVisible();
  });

  test("external file links open war.gov / dvidshub", async ({ page }) => {
    const links = page.locator('table tbody a[href*="war.gov"], table tbody a[href*="dvidshub"]');
    const count = await links.count();
    expect(count).toBeGreaterThan(10);
    const href = await links.first().getAttribute("href");
    expect(href).toMatch(/^https:\/\/(www\.war\.gov|www\.dvidshub\.net)\//);
  });
});
