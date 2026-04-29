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
    console.log("Navigating to Search Results...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(5000);

    // Accept cookies
    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
        console.log("Accepted cookies");
    } catch (e) {
        console.log("Cookie button not found or already accepted");
    }

    await page.waitForTimeout(3000);

    // Find and click the monthy price or calculate button
    let clicked = false;
    const buttons = await page.locator('button, a').all();
    for (const btn of buttons) {
        try {
            const text = await btn.innerText();
            if (text.toLowerCase().includes('maand') || text.toLowerCase().includes('bereken')) {
                console.log("Clicking button:", text);
                await btn.click({ force: true });
                clicked = true;
                break;
            }
        } catch (e) { }
    }

    if (!clicked) {
        try {
            await page.locator('.wb-button--secondary').first().click({ force: true });
        } catch (e) { }
    }

    // Wait 8s for the finance modal/widget to load
    await page.waitForTimeout(8000);
    console.log("Running deep Shadow DOM extractor...");

    const widgetData = await page.evaluate(() => {
        let results = [];

        function traverse(node) {
            if (!node) return;

            if (node.nodeType === Node.ELEMENT_NODE) {
                // If it's the exact class the user provided
                if (node.classList && node.classList.contains('fcis-select-box__label') && node.innerText.includes('Ballon')) {
                    // Get the text of the entire widget container
                    // We find a broad parent
                    let container = node.getRootNode().host || node.parentElement.parentElement.parentElement;
                    results.push({
                        foundTarget: node.outerHTML,
                        containerHtml: container ? container.outerHTML : "no container",
                        containerText: container ? container.innerText : "no text"
                    });

                    // Also click it to select balloon financing so the numbers update in the UI!
                    node.click();
                }

                // If the widget has loaded but is on standard finance
                if (node.tagName && node.tagName.toLowerCase().includes('fcis-fincalc')) {
                    results.push({
                        tag: node.tagName,
                        text: node.innerText
                    });
                }
            }

            // Shadow Root
            if (node.shadowRoot) {
                traverse(node.shadowRoot);
            }

            // Children
            if (node.childNodes) {
                for (let child of node.childNodes) {
                    traverse(child);
                }
            }
        }

        traverse(document.body);
        return results;
    });

    console.log("Deep Traversal Results:");
    console.log(JSON.stringify(widgetData, null, 2));

    // Wait extra 5 seconds in case clicking Ballon updated values
    await page.waitForTimeout(5000);

    // Grab the values again after clicking
    const finalData = await page.evaluate(() => {
        let textDump = [];
        function getFcisText(node) {
            if (node.tagName && node.tagName.toLowerCase().includes('fcis-fincalc')) {
                textDump.push(node.innerText);
            }
            if (node.shadowRoot) getFcisText(node.shadowRoot);
            if (node.childNodes) {
                for (let c of node.childNodes) getFcisText(c);
            }
        }
        getFcisText(document.body);
        return textDump;
    });

    console.log("\nFinal Widget Text View:");
    console.log(JSON.stringify(finalData, null, 2));

    await browser.close();
})();
