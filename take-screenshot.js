const { chromium } = require("playwright");
const path = require("path");

(async () => {
    console.log("Starting browser to take a screenshot...");
    const browser = await chromium.launch({ headless: true });
    // Keep it realistic to bypass basic bot checks
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    console.log("Navigating to C-Class stock search...");
    const url = "https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon";
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(e => console.log(e.message));

    console.log("Waiting a bit...");
    await page.waitForTimeout(10000);

    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        if (await cookieBtn.count() > 0) {
            await cookieBtn.first().click({ timeout: 4000 });
            console.log("Cookies accepted.");
            await page.waitForTimeout(5000);
        }
    } catch (e) { }

    const outPath = path.join(__dirname, "page-screenshot.png");
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`Saved screenshot to ${outPath}`);

    const title = await page.title();
    console.log("Page Title:", title);

    await browser.close();
    console.log("Done.");
})();
