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
    console.log("Fetching Search Results...");

    // Clear previous logs
    if (fs.existsSync('graphql-queries.txt')) fs.unlinkSync('graphql-queries.txt');
    if (fs.existsSync('graphql-responses.txt')) fs.unlinkSync('graphql-responses.txt');

    page.on('response', async response => {
        if (response.url().includes('graphql') && response.request().method() === 'POST') {
            try {
                const postData = response.request().postData();
                fs.appendFileSync('graphql-queries.txt', postData + "\n========================\n");

                const bodyText = await response.text();
                fs.appendFileSync('graphql-responses.txt', bodyText + "\n========================\n");
            } catch (e) { }
        }
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    // Accept cookies to let it fully load
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 4000 });
    } catch (e) { }

    await page.waitForTimeout(6000);

    console.log("Done waiting.");
    await browser.close();
})();
