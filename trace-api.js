const { chromium } = require("playwright");

(async () => {
    console.log("Starting browser to trace APIs...");
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
        if (url.includes("graphql") || url.includes("api")) {
            try {
                const body = await resp.text();
                // Check if it has any pricing numbers or "monthly"
                if (body.includes("price") || body.includes("rate") || body.includes("monthly")) {
                    console.log(`\n✅ FOUND API: ${url.substring(0, 150)}`);
                    console.log(`Size: ${body.length}`);
                    console.log(`Sample: ${body.substring(0, 500)}`);
                }
            } catch (e) { }
        }
    });

    console.log("Navigating to models page...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all", {
        waitUntil: "networkidle",
        timeout: 60000,
    });

    console.log("Waiting 5s for late requests...");
    await page.waitForTimeout(5000);

    await browser.close();
    console.log("Done.");
})();
