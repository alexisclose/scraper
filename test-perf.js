const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const fs = require("fs");

chromium.use(stealth);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    console.log("Navigating to vehicle page...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=0551380325", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(10000);

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
    } catch (e) { }

    for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(500);
    }

    // Attempt clicking
    const buttons = await page.locator('button').all();
    for (const btn of buttons) {
        try {
            const text = await btn.innerText();
            if (text.toLowerCase().includes('financier') || text.toLowerCase().includes('bereken') || text.toLowerCase().includes('lease') || text.toLowerCase().includes('krediet')) {
                await btn.click({ force: true });
                await page.waitForTimeout(1000);
            }
        } catch (e) { }
    }

    await page.waitForTimeout(10000);

    console.log("Dumping performance entries...");
    const entries = await page.evaluate(() => {
        return window.performance.getEntriesByType('resource').map(e => ({
            name: e.name,
            type: e.initiatorType
        }));
    });

    fs.writeFileSync('perf-entries.json', JSON.stringify(entries, null, 2));
    console.log(`Wrote ${entries.length} to perf-entries.json`);

    await browser.close();
})();
