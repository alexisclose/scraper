const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
    console.log("Starting browser to trace GraphQL requests...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "nl-BE", viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    page.on("request", async (req) => {
        if (req.url().includes("graphql") && req.method() === "POST") {
            try {
                const postData = req.postData();
                if (postData && postData.includes("C-Klasse")) {
                    console.log("\n✅ Intercepted GraphQL POST with C-Klasse!");
                    console.log(postData.substring(0, 1500));
                }
            } catch (e) { }
        }
    });

    console.log("Navigating to C-Class stock search via the old URL...");
    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log(e.message));

    console.log("Waiting 10s...");
    await page.waitForTimeout(10000);

    await browser.close();
    console.log("Done.");
})();
