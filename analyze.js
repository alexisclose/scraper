// Analyze the saved HTML to understand how prices are associated with model data
const fs = require("fs");

const html = fs.readFileSync("debug-full.html", "utf-8");

// Find all euro price occurrences with surrounding context (200 chars before and after)
const euroRegex = /\u20ac\s*[\d.,]+/g;
let match;
let count = 0;

console.log("=== Looking for price contexts ===\n");

while ((match = euroRegex.exec(html)) !== null && count < 15) {
    const start = Math.max(0, match.index - 300);
    const end = Math.min(html.length, match.index + match[0].length + 200);
    const context = html.substring(start, end);

    console.log(`--- Price ${count}: ${match[0]} ---`);
    // Look for model-name-like attributes near the price
    const modelMatch = context.match(/model[_-]?name['"=:][^'"]*['"]|class-name['"=:][^'"]*['"]|data-model[^>]*|vehicle-name[^'"]*|headline['"]*>[^<]+/i);
    if (modelMatch) console.log("  MODEL:", modelMatch[0].substring(0, 150));

    // Show a clean version of context (remove long attributes)
    const cleanCtx = context.replace(/\s+/g, ' ').substring(0, 500);
    console.log("  CTX:", cleanCtx);
    console.log();
    count++;
}

// Now look for the component/element structure that contains prices
console.log("\n=== Looking for VMOS/model components ===\n");

// Search for known Mercedes-Benz web components
const componentPatterns = [
    /dh-io-vmos[^>]{0,500}/gi,
    /owc-[a-z-]*model[^>]{0,500}/gi,
    /wb-[a-z-]*model[^>]{0,500}/gi,
    /data-model-id[^>]{0,200}/gi,
    /vehicle-card[^>]{0,500}/gi,
    /model-card[^>]{0,300}/gi,
];

componentPatterns.forEach((pat) => {
    const matches = html.match(pat);
    if (matches && matches.length > 0) {
        console.log(`Pattern ${pat}: ${matches.length} matches`);
        matches.slice(0, 3).forEach((m) => console.log("  >", m.substring(0, 300)));
        console.log();
    }
});

// Search for JSON-like structures with price data
console.log("\n=== Looking for JSON price data ===\n");
const jsonPriceRegex = /"price":\s*"?[\d.,]+|"priceValue":\s*"?[\d.,]+|"startingPrice":\s*"?[\d.,]+|"formattedPrice"[^,}]{0,100}/gi;
const jsonMatches = html.match(jsonPriceRegex);
if (jsonMatches) {
    console.log("JSON price matches:", jsonMatches.length);
    jsonMatches.slice(0, 20).forEach((m) => console.log("  >", m));
}

// Look for vehicle/model names near prices
console.log("\n=== Looking for model name patterns ===\n");
const namePatterns = html.match(/"modelName"[^,}]{0,100}|"vehicleName"[^,}]{0,100}|"name":\s*"[A-Z][^"]{2,50}"/gi);
if (namePatterns) {
    console.log("Name matches:", namePatterns.length);
    [...new Set(namePatterns)].slice(0, 30).forEach((m) => console.log("  >", m));
}
