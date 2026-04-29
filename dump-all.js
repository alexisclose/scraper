const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
    console.log("Starting browser to dump ALL JSON APIs...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    const dumpDir = path.join(__dirname, "api-dumps");
    if (!fs.existsSync(dumpDir)) {
        fs.mkdirSync(dumpDir, { recursive: true });
    }

    let reqCount = 0;

    page.on("response", async (resp) => {
        try {
            const url = resp.url();
            const ct = resp.headers()["content-type"] || "";
            // Save if it's JSON or graphql
            if (ct.includes("json") || url.includes("graphql")) {
                const body = await resp.text();
                reqCount++;
                const safeUrl = url.split("?")[0].split("/").pop().replace(/[^a-z0-9]/gi, "_") || "root";
                const filePath = path.join(dumpDir, `${reqCount}-${safeUrl}.json`);
                fs.writeFileSync(filePath, body, "utf-8");
                console.log(`Saved ${ct} response to ${filePath}`);
            }
        } catch (e) { }
    });

    console.log("Navigating to C-Class stock search...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    console.log("Waiting 15s for dynamic content...");
    await page.waitForTimeout(15000);

    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 4000 });
        console.log("Cookies accepted.");
    } catch (e) {
        console.log("No cookie banner.");
    }
    await page.waitForTimeout(5000);

    await browser.close();
    console.log(`Done. Saved ${reqCount} responses.`);
})();
