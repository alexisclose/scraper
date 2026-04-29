const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
    console.log("Starting targeted test for C-Class...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "nl-BE", viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    let foundPrice = false;
    let monthlyPrice = "N/A";

    page.on("response", async (resp) => {
        if (resp.url().includes("graphql")) {
            try {
                const bodyText = await resp.text();
                // Test the expected logic
                if (bodyText.includes('"monthlyRate"') && bodyText.includes('"min"')) {
                    console.log(`\nFound monthlyRate payload: ${bodyText.substring(bodyText.indexOf('"monthlyRate"') - 20, bodyText.indexOf('"monthlyRate"') + 150)}`);
                    // We know the structure is: "monthlyRate":{"values":{"min":272.84
                    const match = bodyText.match(/"monthlyRate"\s*:\s*\{[^}]*"min"\s*:\s*([\d.]+)/);
                    if (match && !foundPrice) {
                        monthlyPrice = `Vanaf € ${match[1].replace(".", ",")} / maand`;
                        foundPrice = true;
                        console.log("\n✅ Extracted Price:", monthlyPrice);
                    }
                }
            } catch (e) { }
        }
    });

    console.log("Navigating to C-Class stock search...");
    const searchUrl = "https://www.mercedes-benz.be/nl_BE/passengercars/buy/new-car/search-results.html?modelIdentifier=c-class&bodyType=saloon";
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log(e.message));

    console.log("Waiting 15s for data load...");
    await page.waitForTimeout(15000);

    console.log(`\nFinal Extracted Value: ${monthlyPrice}`);
    await browser.close();
    console.log("Done.");
})();
