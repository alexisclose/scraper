const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
const fs = require("fs");

(async () => {
    console.log("Starting browser to trace GraphQL requests...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "nl-BE", viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    let reqCount = 0;
    page.on("request", async (req) => {
        if (req.url().includes("graphql") && req.method() === "POST") {
            try {
                const postData = req.postData();
                reqCount++;
                fs.writeFileSync(`req-${reqCount}.json`, postData, "utf-8");
                console.log(`Saved GraphQL POST to req-${reqCount}.json`);
            } catch (e) { }
        }
    });

    console.log("Navigating to C-Class stock search...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log(e.message));

    console.log("Waiting 10s...");
    await page.waitForTimeout(10000);

    // Let's also search for a button to click that filters by C-Class? Not needed, we just navigated to `?class=c-class`

    await browser.close();
    console.log("Done.");
})();
