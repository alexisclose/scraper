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
    console.log("Navigating directly to vehicle page to dump JSON traffic...");

    if (fs.existsSync('all-json.txt')) fs.unlinkSync('all-json.txt');

    page.on('response', async response => {
        if (response.request().resourceType() === 'fetch' || response.request().resourceType() === 'xhr') {
            try {
                const text = await response.text();
                if (text.includes('duration') || text.includes('balloon') || text.includes('interestRate')) {
                    fs.appendFileSync('all-json.txt', `URL: ${response.url()}\n\nRES: ${text.substring(0, 1500)}\n========================\n`);
                    console.log("Found match from", response.url());
                }
            } catch (e) { }
        }
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=0551380325", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(15000); // 15s to let calculators load
    console.log("Done checking product page.");

    await browser.close();
})();
