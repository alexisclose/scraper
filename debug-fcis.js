// Test auto-detecting fundingProduct name
(async () => {
    const FCIS_URL = "https://api.oneweb.mercedes-benz.com/fcis-calculation-api/v1/calculation/CC/BE/nl";
    const headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://www.mercedes-benz.be",
        "Referer": "https://www.mercedes-benz.be/"
    };

    // Let's test non-compact model: EQE Berline
    const carPrice = 67760;
    const baumuster = "2951111"; // EQE Berline
    const customerType = "business";

    console.log("1. Init call to get defaults...");
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
    const engineId = JSON.parse(initData.opaque)?._engineId;

    // Auto-detect the funding product from the init response and input items
    let fundingProductFromOutput = initData.output?.financingProduct?.label;
    let fundingProductFromInput = initData.input?.items?.find(i => i.id === "fundingProduct")?.value?.value;

    console.log("Engine ID:", engineId);
    console.log("Product from Output:", fundingProductFromOutput);
    console.log("Product from Input:", fundingProductFromInput);

    if (!fundingProductFromInput) {
        console.error("Could not find fundingProduct in init response input items");
        return;
    }

    console.log("\n2. Making calculation call with detected product name:", fundingProductFromInput);

    const dpPct = 0.20;
    const residualPct = 0.25;
    const downpayment = String(Math.round(carPrice * dpPct * 100) / 100);
    const balloon = String(Math.round(carPrice * residualPct * 100) / 100);
    const duration = "48";

    const payload = {
        vehicle: {
            condition: { condition: "new" },
            prices: [{ id: "baseListPrice", currency: "EUR", rawValue: carPrice }, { id: "grossListPrice", currency: "EUR", rawValue: carPrice }],
            vehicleConfiguration: { division: "pc", brand: "mercedes-benz", baumuster, equipments: [] },
            technicalData: [], alternativeConfiguration: []
        },
        input: [
            { id: "fundingProduct", value: fundingProductFromInput },
            { id: "customerType", value: customerType },
            { id: "carPrice", value: String(carPrice) },
            { id: "downpayment", value: downpayment },
            { id: "duration", value: duration },
            { id: "balloon", value: balloon }
        ],
        opaque: JSON.stringify({
            services: {},
            _engineId: engineId,
            _downpayment: true,
            "_dp%": dpPct,
            _balloon: true,
            _carPrice: carPrice,
            customerType: customerType,
            fundingProduct: fundingProductFromInput,
            carPrice: String(carPrice),
            downpayment: downpayment,
            duration: duration,
            balloon: balloon
        })
    };

    const calculationRes = await fetch(FCIS_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    const data = await calculationRes.json();

    const fs = data.output?.containers?.find(c => c.id === "fullSummary");
    const getField = (id) => fs?.items?.find(i => i.id === id)?.value;

    console.log("\nResult:");
    console.log("Product:", data.output?.financingProduct?.label);
    console.log("Monthly:", getField("pmtGross"));
    console.log("Interest:", getField("anr"));
    console.log("Down Payment:", getField("dpGross"));
    console.log("Balloon:", getField("rvBalloon"));
    console.log("Duration:", getField("numberInstallments"));
})();
