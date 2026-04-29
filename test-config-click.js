const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const fs = require("fs");

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

    if (fs.existsSync('config-api.txt')) fs.unlinkSync('config-api.txt');

    // Log ALL requests after click
    page.on('response', async res => {
        const url = res.url();
        if (url.includes('graphql') || url.includes('finance') || url.includes('calc') || url.includes('fcis')) {
            try {
                const text = await res.text();
                fs.appendFileSync('config-api.txt', `URL: ${url}\nMethod: ${res.request().method()}\nRES: ${text.substring(0, 3000)}\n========================\n`);
            } catch (e) { }
        }
    });

    const url = "https://www.mercedes-benz.be/nl_BE/passengercars/mercedes-benz-cars/car-configurator.html/motorization/CCci/BE/nl/bm/1743111,1743111_BE5,1743111_BE6,1743131,1743131_BE5,1743131_BE6,1743151,1743151_BE5,1743151_BE6,1743441_BE5,1743441_BE6";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await page.waitForTimeout(10000);

    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        await cookieBtn.first().click({ timeout: 5000 });
        console.log("Accepted cookies");
    } catch (e) { }

    await page.waitForTimeout(5000);

    console.log("Looking for 'vanaf' or the calculator button...");

    // Try to find the exact element the user mentioned
    try {
        // Use a broad text locator for "vanaf"
        const vanafLocators = await page.getByText(/vanaf/i).all();
        console.log(`Found ${vanafLocators.length} elements containing 'vanaf'`);

        let found = false;
        for (const loc of vanafLocators) {
            const visible = await loc.isVisible();
            if (visible) {
                console.log("Found visible 'vanaf' element. Trying to click nearby buttons...");
                // Look for standard buttons near this element
                const parent = loc.locator('..').locator('..');
                const btns = await parent.locator('button').all();
                if (btns.length > 0) {
                    console.log(`Clicking adjacent button`);
                    await btns[0].click({ force: true });
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            console.log("Fallback: searching for SVG calculator path...");
            // Just evaluate and click any element with class containing 'calculator' or nested SVG
            await page.evaluate(() => {
                const svgs = document.querySelectorAll('svg');
                for (let svg of svgs) {
                    if (svg.innerHTML.includes('M18 2H6a1') || svg.outerHTML.includes('calculator')) {
                        let btn = svg.closest('button');
                        if (btn) btn.click();
                    }
                }
            });
            console.log("Clicked matching SVG icons.");
        }
    } catch (e) {
        console.error(e);
    }

    await page.waitForTimeout(10000); // give time for network calls and modal rendering

    // Let's dump the shadow DOM again
    const dump = await page.evaluate(() => {
        let textDump = [];
        let nodesHtml = [];
        function getFcisText(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.innerText && node.innerText.includes('Ballon')) {
                    textDump.push(node.innerText);
                    nodesHtml.push(node.outerHTML);
                }
            }
            if (node.shadowRoot) getFcisText(node.shadowRoot);
            if (node.childNodes) {
                for (let c of node.childNodes) getFcisText(c);
            }
        }
        getFcisText(document.body);
        return { textDump, nodesHtml };
    });

    console.log("Modal text found:", dump.textDump.length);
    fs.writeFileSync('config-modal.json', JSON.stringify(dump, null, 2));

    await browser.close();
})();
