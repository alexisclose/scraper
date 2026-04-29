const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
    console.log("Starting browser to evaluate models.html...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    let allJson = [];

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    await page.waitForTimeout(5000);
    const html = await page.content();

    // Find all <script type="application/json"> or similar, or just extract the large data blobs
    // The scraper.js uses a custom curly-brace matching logic to get 'technicalData'.
    // Let's just find "c-class" and print the 4000 chars around it to see everything about it.
    const indices = [];
    let idx = html.indexOf('"classId":"c-class"');
    while (idx !== -1) {
        indices.push(idx);
        idx = html.indexOf('"classId":"c-class"', idx + 1);
    }

    console.log(`Found "classId":"c-class" ${indices.length} times.`);
    indices.forEach((index, i) => {
        const snippet = html.substring(Math.max(0, index - 1000), index + 3000);
        fs.writeFileSync(`c-class-snippet-${i}.txt`, snippet, "utf-8");
        console.log(`Saved snippet ${i} to c-class-snippet-${i}.txt`);
    });

    // Let's also search the whole HTML for "monthlyRate", "lease", "rent", "installment"
    console.log("\nSearching models.html for finance keywords...");
    ["monthlyRate", "installment", "lease", "finance", "maand"].forEach(kw => {
        const matches = [...html.matchAll(new RegExp(`.{0,50}${kw}.{0,50}`, "gi"))];
        console.log(`Keyword '${kw}' found ${matches.length} times.`);
        if (matches.length > 0 && matches.length < 50) {
            matches.slice(0, 5).forEach(m => console.log("  ->", m[0].replace(/\n/g, " ")));
        }
    });

    await browser.close();
    console.log("Done.");
})();
