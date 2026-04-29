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
    console.log("Fetching Models Overview...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(5000);
    const html = await page.content();

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
            if (obj.name && obj.name.includes("CLA")) {
                console.log("\n--- Found CLA Match ---");
                console.log("Name:", obj.name);
                console.log("Price:", obj.technicalData.priceData.all?.formattedValue);
                console.log("Propulsion:", obj.fuelType || obj.propulsion || "N/A");
                console.log("Badges:", JSON.stringify(obj.badges));
                console.log("ModelId:", obj.modelId);
                console.log("ClassId:", obj.classId);
            }
        } catch (e) { }
        startIdx = idx + 1;
    }

    await browser.close();
})();
