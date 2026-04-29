// Test: Intercept FCIS API call on a model page to capture baumuster
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    });

    // Test with CLA Electric 
    const testUrls = [
        { name: "CLA Elektrisch", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/cla-electric/overview.html" },
        { name: "EQE Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/eqe/overview.html" },
    ];

    for (const { name, url } of testUrls) {
        console.log(`\n=== ${name} ===`);

        let capturedBaumuster = null;
        let capturedPayload = null;

        // Intercept requests to the FCIS API
        await page.route("**/fcis-calculation-api/**", async (route) => {
            const request = route.request();
            if (request.method() === "POST") {
                try {
                    const body = JSON.parse(request.postData());
                    const bm = body?.vehicle?.vehicleConfiguration?.baumuster;
                    if (bm) {
                        capturedBaumuster = bm;
                        capturedPayload = body;
                        console.log(`  Captured baumuster: ${bm}`);
                        console.log(`  Model name: ${body?.vehicle?.name}`);
                        console.log(`  Gross price: ${body?.vehicle?.prices?.find(p => p.id === "grossListPrice")?.rawValue}`);
                    }
                } catch (e) { }
            }
            await route.continue();
        });

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

        // Wait for the finance widget to load and make its API call
        await page.waitForTimeout(8000);

        if (capturedBaumuster) {
            console.log(`  ✅ Baumuster: ${capturedBaumuster}`);
        } else {
            console.log(`  ❌ No FCIS API call captured`);
            // Try scrolling to trigger lazy loading
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(5000);
            if (capturedBaumuster) {
                console.log(`  ✅ After scroll - Baumuster: ${capturedBaumuster}`);
            } else {
                console.log(`  ❌ Still no FCIS call after scrolling`);
            }
        }

        // Unroute for next iteration
        await page.unroute("**/fcis-calculation-api/**");
    }

    await browser.close();
})();
