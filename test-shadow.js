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

    await page.waitForTimeout(10000); // 10s wait

    console.log("Deep scanning full DOM + all Shadow Roots...");

    const result = await page.evaluate(() => {
        let foundElements = [];

        function scanNode(node) {
            if (!node) return;

            // Check text content of this specific node if it's an element
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.className && typeof node.className === 'string' && node.className.includes('fcis')) {
                    foundElements.push({ tag: node.tagName, class: node.className, text: node.innerText });
                }

                // If it's the exact class
                if (node.classList && node.classList.contains('fcis-select-box__label')) {
                    foundElements.push({ exact: true, text: node.innerText, html: node.outerHTML });
                }
            }

            // Scan children
            if (node.childNodes && node.childNodes.length > 0) {
                for (let child of node.childNodes) {
                    scanNode(child);
                }
            }

            // Scan shadow DOM if exists
            if (node.shadowRoot) {
                scanNode(node.shadowRoot);
            }
        }

        scanNode(document.body);
        return foundElements;
    });

    console.log(`Found ${result.length} matches.`);
    if (result.length > 0) {
        console.log(JSON.stringify(result.slice(0, 10), null, 2));
    }

    // Attempt to download the JSON blob from "window.initialData" for the product page just in case
    const initialData = await page.evaluate(() => typeof window.initialData !== 'undefined' ? JSON.stringify(window.initialData).substring(0, 500) : "No initialData");
    console.log("\nInitialData present?", initialData !== "No initialData");

    await browser.close();
})();
