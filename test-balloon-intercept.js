const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const fs = require("fs");

chromium.use(stealth);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    console.log("Fetching Search Results to find a car...");

    let productUrl = null;

    // We will listen for the graphql search results to get a car ID
    page.on('response', async response => {
        if (response.url().includes('graphql') && response.request().method() === 'POST' && !productUrl) {
            try {
                const json = await response.json();
                if (json.data && json.data.search && json.data.search.results && json.data.search.results.length > 0) {
                    const car = json.data.search.results[0];
                    const id = car.identification.vxVehicleId || car.identification.commissionNumber || car.identification.vin;
                    if (id) {
                        productUrl = `https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=${id}`;
                        console.log("Found car! URL will be:", productUrl);
                    }
                }
            } catch (e) { }
        }
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 4000 });
    } catch (e) { }

    await page.waitForTimeout(6000);

    if (productUrl) {
        console.log("Navigating to Product Page to intercept Finance API...");

        if (fs.existsSync('finance-api.txt')) fs.unlinkSync('finance-api.txt');

        page.on('response', async response => {
            const url = response.url();
            if (url.includes('finance') || url.includes('payment') || url.includes('pricing') || url.includes('graphql')) {
                try {
                    const text = await response.text();
                    if (text.includes('duration') || text.includes('downPayment') || text.includes('interestRate')) {
                        console.log("\n!!! Found Finance API Response !!! ->", url);
                        fs.appendFileSync('finance-api.txt', `URL: ${url}\n\nPOST: ${response.request().postData()}\n\nRES: ${text}\n========================\n`);
                    }
                } catch (e) { }
            }
        });

        await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(10000); // 10s to let finance calculators load
        console.log("Done checking product page.");
    } else {
        console.log("Could not extract a product URL.");
    }

    await browser.close();
})();
