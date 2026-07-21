const { test, expect } = require("./helpers/test");

const CATEGORY_LABELS = [
  "Surface (10)",
  "Precip (7)",
  "Radar (3)",
  "Clouds (2)",
  "Upper Air (24)",
  "Severe (21)",
  "Winter (12)",
];

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
}

test("render menu opens from the header and shows the 7 categories with full-tier defaults", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);

  const drawer = page.getByRole("dialog", { name: "Render" });
  await expect(drawer).toBeVisible();

  for (const label of ["Surface", "Precip", "Radar", "Clouds", "Upper Air", "Severe", "Winter"]) {
    await expect(drawer.getByText(label, { exact: false }).first()).toBeVisible();
  }

  // All 7 category checkboxes default to enabled (scoped by their aria-labels so
  // the unchecked GFS/NAM model checkboxes are not swept in).
  for (const label of CATEGORY_LABELS) {
    await expect(drawer.getByRole("checkbox", { name: label })).toBeChecked();
  }

  // Tier radios exist ONLY on Severe + Winter, and default to Full.
  await expect(drawer.getByRole("radio", { name: "Severe Full" })).toBeChecked();
  await expect(drawer.getByRole("radio", { name: "Winter Full" })).toBeChecked();
  await expect(drawer.getByRole("radio", { name: "Surface Full" })).toHaveCount(0);
});

test("toggling a category persists to localStorage across reload", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  const radarCheckbox = drawer.getByRole("checkbox", { name: "Radar (3)" });
  await radarCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(radarCheckbox).not.toBeChecked();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.render.v1");
        return raw ? JSON.parse(raw).categories.radar.enabled : null;
      }),
    )
    .toBe(false);

  await page.reload();
  await openRenderMenu(page);
  await expect(
    page.getByRole("dialog", { name: "Render" }).getByRole("checkbox", { name: "Radar (3)" }),
  ).not.toBeChecked();
});

test("severe tier toggle persists and reset restores all-on full defaults", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  await drawer.getByRole("radio", { name: "Severe Simple" }).check();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.render.v1");
        return raw ? JSON.parse(raw).categories.severe.tier : null;
      }),
    )
    .toBe("simple");

  await drawer.getByRole("button", { name: "Reset" }).click();
  await expect(drawer.getByRole("radio", { name: "Severe Full" })).toBeChecked();
  await expect(drawer.getByRole("checkbox", { name: "Radar (3)" })).toBeChecked();
});

test("submit disables when zero categories are enabled", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  for (const label of CATEGORY_LABELS) {
    await drawer.getByRole("checkbox", { name: label }).uncheck();
  }

  // The server 400s a zero-category render; the UI must not offer it.
  await expect(drawer.getByRole("button", { name: "▶ Render" })).toBeDisabled();
  await expect(drawer.getByText("Enable at least one category")).toBeVisible();

  // Re-enabling any category restores the submit.
  await drawer.getByRole("checkbox", { name: "Radar (3)" }).check();
  await expect(drawer.getByRole("button", { name: "▶ Render" })).toBeEnabled();
});

test("HRRR-only products grey out Winter full-tier note when no CAM model is selected", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  // Deselect every CAM (hrrr, nam3km) so only non-CAM models remain selected.
  await drawer.getByRole("checkbox", { name: "HRRR", exact: true }).uncheck();
  await drawer.getByRole("checkbox", { name: "NAM 3km", exact: true }).uncheck();
  // Ensure at least one model stays selected.
  await drawer.getByRole("checkbox", { name: "GFS", exact: true }).check();

  // The CAM-only Winter sub-note becomes greyed (data-cam-only marker).
  await expect(drawer.locator("[data-cam-only='true']").first()).toBeVisible();
});
