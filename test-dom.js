const { chromium } = require("playwright");

(async () => {
    console.log("Starting browser to test DOM extraction of lease price...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    console.log("Navigating to C-Class stock search...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    console.log("Waiting 10s for dynamic pricing to load...");
    await page.waitForTimeout(10000);

    // Accept cookies if present to unblock rendering
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 4000 });
        console.log("Cookies accepted.");
    } catch (e) {
        console.log("No cookie banner found or click failed.");
    }

    await page.waitForTimeout(5000); // Wait another 5s for re-render after cookie accept

    console.log("Evaluating DOM for monthly prices...");
    const domText = await page.evaluate(() => document.body.innerText);

    // Look for various formats of leasing prices
    // Example: "Vanaf € 649,00 / maand"
    const leaseMatches = domText.match(/€\s*[\d.,]+\s*\/\s*maand/gi) || [];

    if (leaseMatches.length > 0) {
        console.log("\n✅ Found lease prices in DOM:");
        // Deduplicate
        const uniqueMatches = [...new Set(leaseMatches)];
        uniqueMatches.forEach(match => console.log(match.trim()));
    } else {
        console.log("\n❌ No lease prices found in plain text.");

        // Let's try to look at the HTML structure for "monthlyRate"
        const html = await page.content();
        const jsonMatches = html.match(/"monthlyRate"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/g);
        if (jsonMatches) {
            console.log("\n✅ Found 'monthlyRate' inside HTML JSON blobs:");
            console.log(jsonMatches.slice(0, 3));
        } else {
            console.log("Could not find monthly prices anywhere.");
        }
    }

    await browser.close();
    console.log("Done.");
})();
