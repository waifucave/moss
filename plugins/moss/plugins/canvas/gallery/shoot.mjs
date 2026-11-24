// Renders every canvas story to PNG, light and dark, with headless Chromium (CI only: `node shoot.mjs <page> <out>`).
// Each story fills a 1440×900 window (`#story=<id>&bare=1`); what moves is pinned part-way (`freeze=1`, page.css), since
// a capture doesn't advance CSS animations. Exits non-zero when the page logged an error.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [pageArg, outArg] = process.argv.slice(2);
if (!pageArg || !outArg) {
  console.error("usage: node shoot.mjs <page> <out>");
  process.exit(2);
}
const STORIES = ["scene", "new-agents", "wave", "still", "open", "bot", "plus", "plus-model", "plus-folder", "many", "empty", "focus", "corner"];
const browser = await chromium.launch();
const problems = [];
for (const theme of ["light", "dark"]) {
  mkdirSync(join(resolve(outArg), theme), { recursive: true });
  for (const story of STORIES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC" });
    page.on("pageerror", (e) => problems.push(`${theme}/${story}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`${theme}/${story}: ${m.text()}`); });
    await page.goto(`${pathToFileURL(resolve(pageArg)).href}#story=${story}&theme=${theme}&bare=1&freeze=1`);
    await page.waitForSelector(".cv, .cv-corner", { timeout: 20_000 });
    await page.waitForTimeout(story === "wave" ? 1_500 : 400);
    await page.screenshot({ path: join(resolve(outArg), theme, `${story}.png`) });
    console.log(`  ${theme}/${story}`);
    await page.close();
  }
}
await browser.close();
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
