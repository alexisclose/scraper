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
    console.log("Navigating to configurator...");

    if (fs.existsSync('configurator-logs.txt')) fs.unlinkSync('configurator-logs.txt');

    // Log ALL requests to see if we can find the API
    page.on('response', async res => {
        const url = res.url();
        if (url.includes('graphql') || url.includes('finance') || url.includes('calc') || url.includes('fcis')) {
            try {
                const text = await res.text();
                fs.appendFileSync('configurator-logs.txt', `URL: ${url}\nMethod: ${res.request().method()}\nRES: ${text.substring(0, 3000)}\n========================\n`);
            } catch (e) { }
        }
    });

    const url = "https://www.mercedes-benz.be/nl_BE/passengercars/mercedes-benz-cars/car-configurator.html/motorization/CCci/BE/nl/bm/1743111,1743111_BE5,1743111_BE6,1743131,1743131_BE5,1743131_BE6,1743151,1743151_BE5,1743151_BE6,1743441_BE5,1743441_BE6";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await page.waitForTimeout(5000);

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
        console.log("Accepted cookies");
    } catch (e) {
        console.log("Cookie button not found");
    }

    await page.waitForTimeout(5000);

    // Try to find the calculator icon in the top left
    // Look for anything resembling a monthly price and a calculator
    console.log("Looking for calculator icon...");
    try {
        // Find all buttons, look for something with the calculator icon svg or near the price
        const calcBtn = await page.locator('button:has(svg), wb-icon[name="calculator"]').all();
        console.log(`Found ${calcBtn.length} potential calculator icons.`);

        let found = false;

        // Also look for price starting with "Vanaf" or containing "/maand"
        const priceElems = await page.locator(':has-text("/maand"), :has-text("/ maand")').all();
        for (const el of priceElems) {
            try {
                // Trying to click anything next to it
                const parentBtn = await el.locator('..').locator('button').first();
                if (await parentBtn.count() > 0) {
                    console.log("Clicking button near price element");
                    await parentBtn.click({ force: true });
                    found = true;
                    break;
                }
            } catch (e) { }
        }

        if (!found) {
            // let's just click all svg buttons that might be it
            const buttons = await page.locator('button').all();
            for (const b of buttons) {
                try {
                    const html = await b.innerHTML();
                    if (html.includes('calculator') || html.includes('calc')) {
                        console.log("Clicking button with calculator icon inside!");
                        await b.click({ force: true });
                        found = true;
                        break;
                    }
                } catch (e) { }
            }
        }
    } catch (e) {
        console.error("Error finding calc icon:", e);
    }

    // Wait for the modal/window to open
    await page.waitForTimeout(5000);

    // Dump shadow DOM to look for Ballonfinanciering
    const widgetData = await page.evaluate(() => {
        let results = [];
        function traverse(node) {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.innerText && node.innerText.includes('Ballon')) {
                    const isLabel = node.classList && node.classList.contains('fcis-select-box__label');
                    results.push({
                        tag: node.tagName,
                        text: node.innerText,
                        isLabel
                    });
                    if (isLabel) {
                        node.click(); // Select it
                    }
                }
            }
            if (node.shadowRoot) traverse(node.shadowRoot);
            if (node.childNodes) {
                for (let child of node.childNodes) traverse(child);
            }
        }
        traverse(document.body);
        return results;
    });

    console.log("Elements mentioning Ballon:");
    console.log(JSON.stringify(widgetData, null, 2));

    await page.waitForTimeout(5000);

    fs.writeFileSync('config-page.html', await page.content());

    await browser.close();
})();
