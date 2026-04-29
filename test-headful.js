const { chromium } = require("playwright");
const path = require("path");

(async () => {
    console.log("Starting HEADFUL browser to test bot protection bypass...");
    // Use the actual local Chrome or Edge if possible, but standard bundled chromium headful often works too.
    const browser = await chromium.launch({
        headless: false,
        args: ["--start-maximized"] // Make it look more like a real user session
    });

    const context = await browser.newContext({
        locale: "nl-BE",
        viewport: null
    });

    const page = await context.newPage();

    let foundPrice = false;
    let foundGraphql = false;

    page.on("response", async (resp) => {
        if (resp.url().includes("graphql")) {
            foundGraphql = true;
        }
    });

    console.log("Navigating to C-Class stock search...");
    const url = "https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log(e.message));

    console.log("Waiting 15s for full load...");
    await page.waitForTimeout(15000);

    try {
        const cookieBtn = page.locator('button:has-text("Alles accepteren"), [data-test="handle-accept-all-button"]');
        if (await cookieBtn.count() > 0) {
            await cookieBtn.first().click({ timeout: 4000 });
            console.log("Cookies accepted.");
            await page.waitForTimeout(5000);
        }
    } catch (e) { }

    const outPath = path.join(__dirname, "page-headful-screenshot.png");
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`Saved screenshot to ${outPath}`);

    const html = await page.content();
    if (html.includes("maand")) {
        console.log("✅ YES! The word 'maand' is in the HTML. Headful works!");

        const domText = await page.evaluate(() => document.body.innerText);
        const leaseMatches = domText.match(/€\s*[\d.,]+\s*\/\s*maand/gi) || [];
        if (leaseMatches.length > 0) {
            console.log("\n✅ Found lease prices in DOM:");
            const uniqueMatches = [...new Set(leaseMatches)];
            uniqueMatches.forEach(match => console.log(match.trim()));
        }
    } else {
        console.log("❌ Still no 'maand' found in HTML even with headful browser.");
    }

    console.log(`Found GraphQL requests: ${foundGraphql}`);

    await browser.close();
    console.log("Done.");
})();
