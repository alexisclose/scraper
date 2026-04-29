const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
    console.log("Starting browser to find correct filter URL...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "nl-BE", viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    console.log("Navigating to stock search...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log(e.message));

    console.log("Waiting 15s for data load...");
    await page.waitForTimeout(15000);

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 4000 });
    } catch (e) { }

    await page.waitForTimeout(5000);

    // Click on C-Klasse filter (heuristic)
    try {
        console.log("Looking for C-Klasse filter...");
        // This relies on the UI, let's just dump the HTML of the filter sidebar
        const html = await page.content();
        const cclassIndex = html.toLowerCase().indexOf("c-klasse");
        console.log(`C-Klasse found in HTML at index: ${cclassIndex}`);
        if (cclassIndex !== -1) {
            console.log(html.substring(Math.max(0, cclassIndex - 200), cclassIndex + 200));
        }

        // Find URLs that look like search filtering in the DOM
        const urls = html.match(/href="\/nl_BE\/passengercars\/buy\/new-car\/search-results\.html\?[^"]+"/g) || [];
        const uniqueUrls = [...new Set(urls)];
        console.log("\nFound URLs for filtering:");
        uniqueUrls.slice(0, 10).forEach(u => console.log(u));
    } catch (e) {
        console.log(e);
    }

    await browser.close();
    console.log("Done.");
})();
