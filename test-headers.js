const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
    console.log("Starting browser to trace GraphQL headers...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "nl-BE", viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    let found = false;
    page.on("request", async (req) => {
        if (req.url().includes("graphql") && req.method() === "POST") {
            try {
                if (!found) {
                    console.log(`\nURL: ${req.url()}`);
                    console.log("Headers:", JSON.stringify(req.headers(), null, 2));
                    found = true;
                }
            } catch (e) { }
        }
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log(e.message));

    await page.waitForTimeout(5000);
    await browser.close();
    console.log("Done.");
})();
