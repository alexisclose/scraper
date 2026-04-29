// Debug: Try to capture baumusters for the failing models
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const FAILING_MODELS = [
    { name: "GLE", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/gle/overview.html" },
    { name: "G-Klasse Terreinwagen", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/g-class/overview.html" },
    { name: "CLA Shooting Brake Elektrisch", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/estate/cla-shooting-brake-electric/overview.html" },
    { name: "A-Klasse Hatchback", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/hatchback/a-class/overview.html" },
    { name: "CLE Coupé", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/coupe/cle-coupe/overview.html" },
    { name: "EQT", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/mpv/eqt/overview.html" },
    { name: "EQB", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/eqb/overview.html" },
];

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    });

    for (const model of FAILING_MODELS) {
        const page = await context.newPage();
        console.log(`\n=== ${model.name} ===`);
        console.log(`URL: ${model.url}`);

        let captured = null;
        let fcisCallCount = 0;

        await page.route("**/fcis-calculation-api/**", async (route) => {
            fcisCallCount++;
            const req = route.request();
            if (req.method() === "POST") {
                try {
                    const body = JSON.parse(req.postData());
                    const bm = body?.vehicle?.vehicleConfiguration?.baumuster;
                    if (bm && !captured) {
                        captured = bm;
                        console.log(`  ✅ Captured baumuster: ${bm}`);
                    }
                } catch (e) {
                    console.log(`  ❌ Parse error: ${e.message}`);
                }
            }
            await route.continue();
        });

        try {
            await page.goto(model.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            console.log(`  Page loaded.`);

            // Check for cookie banner
            const cookieBanner = await page.$('cmm-cookie-banner');
            if (cookieBanner) {
                console.log(`  Cookie banner detected, trying to dismiss...`);
                try {
                    await page.evaluate(() => {
                        const banner = document.querySelector('cmm-cookie-banner');
                        if (banner && banner.shadowRoot) {
                            const acceptBtn = banner.shadowRoot.querySelector('button[data-test="handle-accept-all-button"]');
                            if (acceptBtn) acceptBtn.click();
                        }
                    });
                    await page.waitForTimeout(1000);
                } catch (e) { }
            }

            await page.waitForTimeout(6000);

            if (!captured) {
                console.log(`  No FCIS call after 6s, scrolling...`);
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(4000);
            }

            if (!captured) {
                console.log(`  Still no FCIS call. Total FCIS calls intercepted: ${fcisCallCount}`);
                // Check if the financing widget exists on the page
                const hasWidget = await page.evaluate(() => {
                    const widgets = document.querySelectorAll('wb-fcis-calculator, [data-component="fcis"], .fcis-calculator, owc-finance-calculator');
                    return { count: widgets.length, tags: Array.from(widgets).map(w => w.tagName) };
                });
                console.log(`  Finance widget check:`, hasWidget);

                // Try scrolling more specifically
                const scrollResult = await page.evaluate(() => {
                    // Look for any element with "financ" in its attributes or class
                    const all = document.querySelectorAll('*');
                    const found = [];
                    for (const el of all) {
                        const html = el.outerHTML.substring(0, 200);
                        if (html.toLowerCase().includes('fcis') || html.toLowerCase().includes('financ')) {
                            found.push(el.tagName + ': ' + html.substring(0, 100));
                        }
                    }
                    return found.slice(0, 5);
                });
                console.log(`  Finance-related elements:`, scrollResult);
            }

        } catch (e) {
            console.log(`  ❌ Navigation error: ${e.message}`);
        }

        await page.close();
    }

    await browser.close();
})();
