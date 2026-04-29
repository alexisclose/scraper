const { chromium } = require("playwright");

(async () => {
    console.log("Starting browser to trace individual page APIs...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    let found = false;
    page.on("response", async (resp) => {
        try {
            const body = await resp.text();
            // C-class starts at ~€ 48.884,00, lease is typically around € 600 - € 1000
            // We just look for standard lease price indicators in the raw response
            if (body.includes("monthlyRate") || body.includes("installment") || body.includes("lease") || body.includes("finance")) {
                console.log(`\n✅ POTENTIAL API MATCH: ${resp.url().substring(0, 150)}`);
                // Only print snippets containing the juicy bits
                const index = body.indexOf("monthlyRate");
                if (index !== -1) {
                    console.log(`Sample near monthlyRate: ${body.substring(Math.max(0, index - 50), index + 150)}`);
                    found = true;
                }
            }
        } catch (e) { }
    });

    console.log("Navigating to C-Class overview...");
    // Let's use the explicit stock URL like scraper.js tries
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    console.log("Waiting for dynamic content...");
    await page.waitForTimeout(15000); // Give it plenty of time

    if (!found) {
        console.log("Did not find 'monthlyRate' in any response.");
        // Fallback: Check the DOM HTML directly
        const html = await page.content();
        const domMatch = html.match(/"monthlyRate":\{"value":([0-9.]+)/)
        if (domMatch) {
            console.log("Found in DOM JSON blob:", domMatch[1])
        }
    }

    await browser.close();
    console.log("Done.");
})();
