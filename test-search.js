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
    console.log("Navigating to Search Results...");

    // Log all GraphQL/JSON requests
    if (fs.existsSync('search-api.txt')) fs.unlinkSync('search-api.txt');
    page.on('response', async res => {
        const url = res.url();
        if (url.includes('graphql') || url.includes('finance') || url.includes('calc') || url.includes('fcbp')) {
            try {
                const text = await res.text();
                fs.appendFileSync('search-api.txt', `URL: ${url}\nRES: ${text.substring(0, 1500)}\n========================\n`);
            } catch (e) { }
        }
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(6000);

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
    } catch (e) { }

    await page.waitForTimeout(4000);

    // Look for financiering buttons
    const buttons = await page.locator('button').all();
    console.log(`Checking ${buttons.length} buttons on search results...`);
    let clicked = false;
    for (const btn of buttons) {
        try {
            const text = await btn.innerText();
            if (text.toLowerCase().includes('financiering') || text.toLowerCase().includes('bereken') || text.toLowerCase().includes('maand')) {
                console.log("Clicking button:", text);
                await btn.click({ force: true });
                clicked = true;
                break; // just click first one
            }
        } catch (e) { }
    }

    // If no explicit text match, click anything resembling a price/month link
    if (!clicked) {
        try {
            const priceLink = await page.locator(':has-text("/ maand")').first();
            await priceLink.click({ force: true });
            console.log("Clicked a price element.");
        } catch (e) { }
    }

    await page.waitForTimeout(8000);

    // Dump HTML
    const html = await page.content();
    fs.writeFileSync('search-page.html', html);
    console.log("Wrote search-page.html");

    await browser.close();
})();
