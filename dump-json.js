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
    console.log("Fetching Models Overview...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(5000);

    try {
        const data = await page.evaluate(() => JSON.stringify(window.initialData));
        if (data) {
            fs.writeFileSync("initialData.json", data);
            console.log("Wrote initialData.json");
        } else {
            console.log("window.initialData evaluates to empty or undefined.");
        }
    } catch (err) {
        console.error("Failed to run page.evaluate", err);
    }

    await browser.close();
})();
