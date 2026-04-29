const { chromium } = require("playwright");

(async () => {
    console.log("Starting browser to trace individual page APIs...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Intercept and search API responses
    page.on("response", async (resp) => {
        const url = resp.url();
        if (url.includes("graphql") || url.includes("calc")) {
            try {
                const body = await resp.text();
                if (body.includes("rate") || body.includes("installment") || body.includes("price")) {
                    console.log(`\n✅ FOUND calc/graphql API: ${url.substring(0, 150)}`);
                    console.log(`Sample: ${body.substring(0, 300)}`);
                }
            } catch (e) { }
        }
    });

    console.log("Navigating to C-Class overview...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/c-class/overview.html", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    console.log("Waiting 10s for dynamic content...");
    await page.waitForTimeout(10000);

    // Extract text to see if maand is present
    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText);

    console.log("\nSearching for 'maand' in text:");
    const textMatches = text.match(/.{0,50}maand.{0,50}/gi) || [];
    textMatches.forEach(m => console.log(m.replace(/\n/g, " ").trim()));

    if (textMatches.length === 0) {
        console.log("Keyword 'maand' not found in visible text.");
    }

    await browser.close();
    console.log("Done.");
})();
