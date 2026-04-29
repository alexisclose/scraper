const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    console.log("Fetching CLA Elektrisch Overview...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/cla-electric/overview.html", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(5000);
    const html = await page.content();

    // Find initialData
    const match = html.match(/window\.initialData\s*=\s*(\{.*?\});/s);
    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            // Search inside parsed for any price
            console.log("initialData found, searching for prices...");
            const str = JSON.stringify(parsed);

            // Regex to find things like "EUR","formattedValue":"€ 50.000,00"
            const prices = [...new Set([...str.matchAll(/"formattedValue":"€[^"]+"/g)].map(m => m[0]))];
            console.log("Prices found:", prices);

        } catch (e) {
            console.error("Parse error", e);
        }
    } else {
        console.log("No initialData found.");
    }

    // Check DOM just in case
    const text = await page.evaluate(() => document.body.innerText);
    const domPrices = text.match(/€\s*[\d.,]+/g);
    console.log("DOM prices:", [...new Set(domPrices)].slice(0, 10));

    await browser.close();
})();
