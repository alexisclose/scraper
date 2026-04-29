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
    console.log("Navigating to vehicle page...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/product.html?builderId=0551380325", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
    } catch (e) { }

    await page.waitForTimeout(3000);

    // Get all buttons and click ones that might open the finance calculator
    const buttons = await page.locator('button').all();
    console.log(`Found ${buttons.length} buttons.`);

    for (const btn of buttons) {
        try {
            const text = await btn.innerText();
            const lower = text.toLowerCase();
            if (lower.includes('financier') || lower.includes('bereken') || lower.includes('lease') || lower.includes('krediet')) {
                console.log("Clicking button:", text);
                await btn.click({ force: true });
                await page.waitForTimeout(2000);
            }
        } catch (e) { }
    }

    // Now check if fcis-select-box__label is visible
    try {
        console.log("Checking for .fcis-select-box__label");
        const count = await page.locator('.fcis-select-box__label').count();
        if (count > 0) {
            console.log("Found balloon financing label!");

            // Try dumping the surrounding text
            const textContext = await page.evaluate(() => {
                const els = document.querySelectorAll('.fcis-select-box__label');
                for (let el of els) {
                    if (el.innerText.includes('Ballon')) {
                        // Return the text of the main calculator container
                        return el.closest('[class*="fcis"]') ? el.closest('[class*="fcis"]').innerText : el.closest('div').parentElement.innerText;
                    }
                }
                return "Not found";
            });
            console.log("\n--- Finance Widget Text ---");
            console.log(textContext);

            // Try interacting with the Ballon tab
            const balloonLabels = await page.locator('.fcis-select-box__label', { hasText: 'Ballonfinanciering' }).all();
            for (const bl of balloonLabels) {
                await bl.click({ force: true });
            }
            await page.waitForTimeout(3000);

            // Get all network requests after click just in case
        } else {
            console.log("Still could not find the label. It might be deep inside a Shadow DOM that Playwright didn't pierce by default.");
        }
    } catch (e) {
        console.log("Error checking for label:", e);
    }

    await browser.close();
})();
