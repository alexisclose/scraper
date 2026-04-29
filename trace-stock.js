const { chromium } = require("playwright");

(async () => {
    console.log("Starting browser to trace stock search APIs...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Intercept and search API responses
    page.on("response", async (resp) => {
        const url = resp.url();
        const ct = resp.headers()["content-type"] || "";
        if (url.includes("graphql") && ct.includes("json")) {
            try {
                const body = await resp.text();
                // We know it's a search result if it contains "vehicles" or "results"
                if (body.includes("vehicles") || body.includes("results") || body.includes("price")) {
                    console.log(`\n✅ FOUND SEARCH API: ${url.substring(0, 150)}`);
                    console.log(`Size: ${body.length}`);
                    console.log(`Sample: ${body.substring(0, 800)}`);
                }
            } catch (e) { }
        }
    });

    console.log("Navigating to stock search for C-Class...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    console.log("Waiting 10s for dynamic content...");
    await page.waitForTimeout(10000);

    await browser.close();
    console.log("Done.");
})();
