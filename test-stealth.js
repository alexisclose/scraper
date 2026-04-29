const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

// Add stealth plugin and use defaults (all evasion techniques)
chromium.use(stealth);

(async () => {
    console.log("Starting STEALTH browser to bypass bot protection...");
    const browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
        locale: "nl-BE",
        viewport: { width: 1920, height: 1080 }
    });

    const page = await context.newPage();

    let foundPrice = false;

    page.on("response", async (resp) => {
        if (resp.url().includes("graphql")) {
            try {
                const body = await resp.text();
                if (body.includes("monthlyRate")) {
                    console.log("\n✅ BINGO! Found a GraphQL response with 'monthlyRate'!");
                    foundPrice = true;
                    // Just print a tiny snippet so we don't blow up the console
                    const idx = body.indexOf('"monthlyRate"');
                    console.log(body.substring(Math.max(0, idx - 40), idx + 80));
                }
            } catch (e) { }
        }
    });

    console.log("Navigating to C-Class stock search...");
    const url = "https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?class=c-class&bodytype=saloon";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log(e.message));

    console.log("Waiting 15s for full load...");
    await page.waitForTimeout(15000);

    const html = await page.content();
    if (html.includes("maand")) {
        console.log("✅ The word 'maand' rendered in the DOM! Stealth worked.");
    } else {
        console.log("❌ Still no 'maand' found in HTML despite stealth plugin.");
    }

    await browser.close();
    console.log("Done.");
})();
