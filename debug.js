const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Intercept and log API calls
    const apiCalls = [];
    page.on("response", async (resp) => {
        const url = resp.url();
        const ct = resp.headers()["content-type"] || "";
        if (ct.includes("json")) {
            try {
                const body = await resp.text();
                apiCalls.push({ url: url.substring(0, 300), size: body.length, sample: body.substring(0, 500) });
            } catch { }
        }
    });

    console.log("Loading page...");
    await page.goto(
        "https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all",
        { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    console.log("DOM loaded. Waiting 15s for web components...");
    await page.waitForTimeout(15000);

    // Save full HTML
    const html = await page.content();
    fs.writeFileSync("debug-full.html", html, "utf-8");
    console.log("HTML saved:", html.length, "chars");

    // Check for price text
    const text = await page.evaluate(() => document.body.innerText);
    const hasEuro = text.includes("€");
    const hasVanaf = text.includes("Vanaf");
    console.log("Has €:", hasEuro, "| Has Vanaf:", hasVanaf);

    // Find all price-like text
    const priceLines = text.split("\n").filter(l => l.includes("€") || /\d{2}\.\d{3}/.test(l));
    console.log("Price lines:", priceLines.length);
    priceLines.slice(0, 20).forEach(l => console.log("  >", l.trim().substring(0, 200)));

    // Search HTML source for price patterns
    const euroInHtml = (html.match(/€\s*[\d.,]+/g) || []);
    console.log("Euro in HTML source:", euroInHtml.length);
    euroInHtml.slice(0, 10).forEach(m => console.log("  HTML>", m));

    // Search for data attributes with numbers
    const dataAttrs = (html.match(/data-[a-z-]*price[^>]*/gi) || []);
    console.log("Data-price attributes:", dataAttrs.length);
    dataAttrs.slice(0, 5).forEach(m => console.log("  ATTR>", m.substring(0, 200)));

    // Log API calls
    console.log("\nJSON API calls:", apiCalls.length);
    apiCalls.forEach((a, i) => {
        console.log(`\n--- API ${i} ---`);
        console.log("URL:", a.url);
        console.log("Size:", a.size);
        console.log("Sample:", a.sample.substring(0, 400));
    });

    await browser.close();
    console.log("\nDone.");
})();
