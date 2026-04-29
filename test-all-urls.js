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
    console.log("Navigating directly to vehicle page to dump ALL URLs...");

    if (fs.existsSync('all-urls.txt')) fs.unlinkSync('all-urls.txt');

    page.on('response', async response => {
        try {
            fs.appendFileSync('all-urls.txt', `${response.request().method()} ${response.url()}\n`);
        } catch (e) { }
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=0551380325", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(10000);

    // Scroll down to load more content
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

    await page.waitForTimeout(5000);
    console.log("Done checking product page.");

    await browser.close();
})();
