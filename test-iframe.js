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
    console.log("Navigating to vehicle page...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=0551380325", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
    } catch (e) { }

    // Scroll down to potentially trigger lazy loading
    console.log("Scrolling down...");
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(1000);
    }

    await page.waitForTimeout(5000);

    console.log("Checking all iframes...");
    const frames = page.frames();
    console.log(`Found ${frames.length} frames.`);

    for (const frame of frames) {
        try {
            const count = await frame.locator('.fcis-select-box__label').count();
            if (count > 0) {
                console.log(`\nFound .fcis-select-box__label in frame: ${frame.url()}`);
                const html = await frame.content();
                require('fs').writeFileSync('iframe-content.html', html);
                console.log("Wrote iframe HTML to iframe-content.html");
                break;
            }
        } catch (e) { }
    }

    await browser.close();
})();
