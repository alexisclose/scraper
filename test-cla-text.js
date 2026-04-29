const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

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
    const html = await page.content();

    // Dump text content around 'CLA'
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('CLA')) {
            console.log(`-- Match at line ${i} --`);
            console.log(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n'));
        }
    }

    await browser.close();
})();
