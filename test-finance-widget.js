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
    console.log("Navigating to vehicle page to locate Ballonfinanciering...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=0551380325", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
    } catch (e) { }

    try {
        // Wait for the specific element provided by the user
        console.log("Waiting for .fcis-select-box__label...");
        // Wait up to 20 seconds for the element to appear
        await page.waitForSelector('.fcis-select-box__label', { timeout: 20000 });
        console.log("Found .fcis-select-box__label, inspecting it.");

        // We might need to click it if it's a tab
        const labels = await page.locator('.fcis-select-box__label').allTextContents();
        console.log("Available financing options:", labels);

        const balloonLabel = page.locator('.fcis-select-box__label', { hasText: 'Ballonfinanciering' }).first();
        if (await balloonLabel.count() > 0) {
            console.log("Clicking Ballonfinanciering...");
            // Force click it because it might be intercepted
            await balloonLabel.click({ force: true });
            await page.waitForTimeout(3000); // give time to update calculation
        }

        // Now extract the calculated values from the surrounding DOM structure
        // Since we don't know the exact class yet, let's dump all text from the calculator container
        // Based on 'fcis', there is probably an fcis calculator wrapper. Let's find common parents.
        console.log("Dumping text from parents...");
        const widgetText = await page.evaluate(() => {
            const els = document.querySelectorAll('*');
            for (let el of els) {
                if (el.className && typeof el.className === 'string' && el.className.includes('fcis')) {
                    // Let's get the text of its parent to see the numbers
                    return el.parentElement.parentElement.innerText;
                }
            }
            return "Not found";
        });

        console.log("Financing Widget Text:\n", widgetText);

        // Also dump network requests that contain these keywords to find the API
        // This was likely not caught previously because we stopped listening too early or it requires a click
    } catch (e) {
        console.error("Timeout or error waiting for element:", e);
    }

    await browser.close();
})();
