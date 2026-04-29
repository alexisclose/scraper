// Check what the overview page has for EQE and other "missing" models
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        locale: "nl-BE",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    });

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all", {
        waitUntil: "domcontentloaded",
        timeout: 30000
    });
    await page.waitForTimeout(5000);

    const html = await page.content();

    // Search for EQE in the HTML
    const missingModels = ["EQE", "EQS", "EQA", "EQB", "EQT", "EQV", "G-Klasse Elektrisch", "Mercedes-Maybach SL"];

    for (const name of missingModels) {
        const idx = html.indexOf(`"name":"${name}"`);
        if (idx >= 0) {
            // Extract surrounding context
            const context = html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + 500));
            console.log(`\n=== ${name} found at index ${idx} ===`);
            // Look for price near it
            const priceMatch = context.match(/"formattedValue"\s*:\s*"([^"]+)"/);
            const baumusterMatch = context.match(/"baumuster"\s*:\s*"([^"]+)"/);
            console.log("  Price:", priceMatch ? priceMatch[1] : "not in context");
            console.log("  Baumuster:", baumusterMatch ? baumusterMatch[1] : "not in context");
            console.log("  Has priceData:", context.includes("priceData"));
        } else {
            // Try with just the model name - not as an exact "name" field
            const looseIdx = html.indexOf(name);
            console.log(`\n=== ${name}: exact "name" field NOT found, loose text at ${looseIdx >= 0 ? looseIdx : "not found"} ===`);
        }
    }

    // Also, let's find ALL the "name" fields and their associated models
    console.log("\n\n=== ALL MODELS FOUND IN JSON BLOBS ===");
    const extractedModels = new Map();
    let startIdx = 0;
    while (true) {
        const idx = html.indexOf('"technicalData":{"priceData"', startIdx);
        if (idx === -1) break;

        let start = idx;
        let depth = 0;
        for (let i = idx; i >= Math.max(0, idx - 1000); i--) {
            if (html[i] === '}') depth++;
            if (html[i] === '{') {
                if (depth === 0) { start = i; break; }
                depth--;
            }
        }

        let end = idx;
        depth = 0;
        for (let i = start; i < Math.min(html.length, start + 3000); i++) {
            if (html[i] === '{') depth++;
            if (html[i] === '}') {
                depth--;
                if (depth === 0) { end = i + 1; break; }
            }
        }

        const jsonStr = html.substring(start, end);
        try {
            const obj = JSON.parse(jsonStr);
            if (obj.name && obj.technicalData?.priceData) {
                const price = obj.technicalData.priceData.all?.formattedValue || "N/A";
                const isElectric = obj.technicalData.priceData.all?.filters?.ELECTRIC;
                console.log(`  ${obj.name}${isElectric ? " (ELECTRIC)" : ""}: ${price}`);
            }
        } catch (e) { }
        startIdx = idx + 1;
    }

    await browser.close();
})();
