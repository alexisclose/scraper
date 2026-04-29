// Deep analysis: extract full JSON data blocks with model + price + monthly info
const fs = require("fs");

const html = fs.readFileSync("debug-full.html", "utf-8");

// Strategy: find all JSON-like objects that contain "price" key
// The data appears to be in web component props as JSON
// e.g. "price":"Vanaf € 49.610,00","footnote":{...},"ctaLabel":"Meer weten"
// and "name":"C-Klasse Berline" nearby

// Find large JSON blobs in the HTML (embedded in attributes or script tags)
// Look for patterns matching model card data

// First: let's see if there are JSON-like blocks we can parse
// Search for patterns like {"name":"...", ... "price":"..."}
const modelPriceRegex = /"name"\s*:\s*"([^"]+)"[^}]{0,2000}?"price"\s*:\s*"([^"]+)"/g;
const results1 = [];
let m;
while ((m = modelPriceRegex.exec(html)) !== null) {
    results1.push({ name: m[1], price: m[2] });
}
console.log("=== name->price matches:", results1.length, "===");
results1.forEach(r => console.log(`  ${r.name}: ${r.price}`));

// Also try reverse: price first, then name
const priceThenName = /"price"\s*:\s*"([^"]+)"[^}]{0,2000}?"name"\s*:\s*"([^"]+)"/g;
const results2 = [];
while ((m = priceThenName.exec(html)) !== null) {
    results2.push({ name: m[2], price: m[1] });
}
console.log("\n=== price->name matches:", results2.length, "===");
results2.forEach(r => console.log(`  ${r.name}: ${r.price}`));

// Look for monthly/leasing prices
console.log("\n=== Monthly/leasing patterns ===");
const monthlyPatterns = [
    /maand[^"]{0,200}/gi,
    /"monthlyRate"[^,}]{0,100}/gi,
    /"leasing"[^,}]{0,200}/gi,
    /"financ[^"]*"[^,}]{0,100}/gi,
    /"rate":\s*"[^"]+"/gi,
];
monthlyPatterns.forEach(pat => {
    const matches = html.match(pat);
    if (matches && matches.length > 0) {
        console.log(`${pat}: ${matches.length} matches`);
        [...new Set(matches)].slice(0, 5).forEach(m => console.log("  >", m.substring(0, 200)));
    }
});

// Let's also look at the broader structure around a "name" entry
console.log("\n=== Broader context around 'C-Klasse Berline' ===");
const idx = html.indexOf('"name":"C-Klasse Berline"');
if (idx > -1) {
    // Go back to find the start of the JSON object
    let start = idx;
    let depth = 0;
    for (let i = idx; i >= Math.max(0, idx - 5000); i--) {
        if (html[i] === '}') depth++;
        if (html[i] === '{') {
            if (depth === 0) { start = i; break; }
            depth--;
        }
    }
    // Go forward to find the end
    let end = idx;
    depth = 0;
    for (let i = start; i < Math.min(html.length, start + 10000); i++) {
        if (html[i] === '{') depth++;
        if (html[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    const jsonStr = html.substring(start, end);
    console.log("JSON block length:", jsonStr.length);
    try {
        const obj = JSON.parse(jsonStr);
        console.log("Parsed successfully! Keys:", Object.keys(obj));
        console.log(JSON.stringify(obj, null, 2).substring(0, 3000));
    } catch (e) {
        // Try to show relevant parts
        console.log("Parse failed, showing raw excerpt:");
        console.log(jsonStr.substring(0, 2000));
    }
}
