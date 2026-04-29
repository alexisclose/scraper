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
    console.log("Navigating directly to vehicle page to dump ALL traffic containing ' Ballon'...");

    if (fs.existsSync('all-traffic.txt')) fs.unlinkSync('all-traffic.txt');

    page.on('response', async response => {
        try {
            const text = await response.text();
            if (text.includes('Ballon') || text.includes('fcis-select-box')) {
                fs.appendFileSync('all-traffic.txt', `URL: ${response.url()}\nType: ${response.request().resourceType()}\nMethod: ${response.request().method()}\nRES: ${text.substring(0, 1000)}\n========================\n`);
                console.log("Found match from", response.url());
            }
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

    await page.waitForTimeout(5000);
    console.log("Done checking product page.");

    await browser.close();
})();
