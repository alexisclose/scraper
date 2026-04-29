// Check available funding products
(async () => {
    const FCIS_URL = "https://api.oneweb.mercedes-benz.com/fcis-calculation-api/v1/calculation/CC/BE/nl";
    const headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://www.mercedes-benz.be",
        "Referer": "https://www.mercedes-benz.be/"
    };

    const carPrice = 67760;
    const baumuster = "2951111"; // EQE Berline
    const customerType = "business";

    const initRes = await fetch(FCIS_URL, {
        method: "POST", headers, body: JSON.stringify({
            vehicle: {
                condition: { condition: "new" },
                prices: [{ id: "baseListPrice", currency: "EUR", rawValue: carPrice }, { id: "grossListPrice", currency: "EUR", rawValue: carPrice }],
                vehicleConfiguration: { division: "pc", brand: "mercedes-benz", baumuster, equipments: [] },
                technicalData: [], alternativeConfiguration: []
            },
            input: [{ id: "customerType", value: customerType }]
        })
    });

    const initData = await initRes.json();

    const fpItem = initData.input?.items?.find(i => i.id === "fundingProduct");
    console.log("Available funding products for EQE (business):");
    if (fpItem && fpItem.options) {
        fpItem.options.forEach(opt => console.log(` - [${opt.value}] ${opt.label}`));
    } else {
        console.log("No options found in response.", fpItem);
    }

    // Also try private customer
    const initResPrivate = await fetch(FCIS_URL, {
        method: "POST", headers, body: JSON.stringify({
            vehicle: { condition: { condition: "new" }, prices: [{ id: "baseListPrice", currency: "EUR", rawValue: carPrice }, { id: "grossListPrice", currency: "EUR", rawValue: carPrice }], vehicleConfiguration: { division: "pc", brand: "mercedes-benz", baumuster, equipments: [] } },
            input: [{ id: "customerType", value: "private" }]
        })
    });
    const initDataPrivate = await initResPrivate.json();
    const fpItemPrivate = initDataPrivate.input?.items?.find(i => i.id === "fundingProduct");
    console.log("\nAvailable funding products for EQE (private):");
    if (fpItemPrivate && fpItemPrivate.options) {
        fpItemPrivate.options.forEach(opt => console.log(` - [${opt.value}] ${opt.label}`));
    }
})();
