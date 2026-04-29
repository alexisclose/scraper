const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();
    console.log("Navigating to configurator...");

    const url = "https://www.mercedes-benz.be/nl_BE/passengercars/mercedes-benz-cars/car-configurator.html/motorization/CCci/BE/nl/bm/1743111,1743111_BE5,1743111_BE6,1743131,1743131_BE5,1743131_BE6,1743151,1743151_BE5,1743151_BE6,1743441_BE5,1743441_BE6";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await page.waitForTimeout(10000); // 10s wait for load

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
        console.log("Accepted cookies");
    } catch (e) { }

    await page.waitForTimeout(5000);

    // Make screenshot
    await page.screenshot({ path: 'configurator-view.png' });
    console.log("Wrote configurator-view.png");

    await browser.close();
})();
