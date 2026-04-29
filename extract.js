const fs = require("fs");

const html = fs.readFileSync("debug-full.html", "utf-8");

const results = [];
let startIdx = 0;

while (true) {
    const idx = html.indexOf('"technicalData":{"priceData"', startIdx);
    if (idx === -1) break;

    // Go back to find the start of the object
    let start = idx;
    let depth = 0;
    for (let i = idx; i >= Math.max(0, idx - 1000); i--) {
        if (html[i] === '}') depth++;
        if (html[i] === '{') {
            if (depth === 0) { start = i; break; }
            depth--;
        }
    }

    // Go forward to find the end
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
        if (obj.name && obj.technicalData && obj.technicalData.priceData) {
            results.push(obj);
        }
    } catch (e) {
    }

    startIdx = idx + 1;
}

console.log(`Found ${results.length} models with priceData.`);
const uniqueModels = new Map();
results.forEach(r => {
    if (!uniqueModels.has(r.name)) {
        uniqueModels.set(r.name, r);
    }
});

console.log(`Unique models: ${uniqueModels.size}`);
for (const [name, data] of uniqueModels.entries()) {
    const allPrice = data.technicalData.priceData.all?.formattedValue || "N/A";
    console.log(`- ${name}: ${allPrice}`);
}
console.log(JSON.stringify(uniqueModels.get("C-Klasse Berline").technicalData.priceData, null, 2));
