// Test direct call to the FCIS Calculation API for Balloon Financing
(async () => {
    const FCIS_URL = "https://api.oneweb.mercedes-benz.com/fcis-calculation-api/v1/calculation/CC/BE/nl";

    // Minimal payload based on the user's intercepted request
    const payload = {
        vehicle: {
            condition: { condition: "new" },
            name: "GLB 250+ electric",
            prices: [
                { id: "baseListPrice", currency: "EUR", rawValue: 58685 },
                { id: "grossListPrice", currency: "EUR", rawValue: 58685 }
            ],
            vehicleConfiguration: {
                division: "pc",
                brand: "mercedes-benz",
                baumuster: "2446131",
                modelYear: "807",
                changeYear: "",
                nst: null,
                equipments: []
            },
            technicalData: [
                { id: "fuelType", value: "Elektrisch" }
            ],
            alternativeConfiguration: []
        },
        input: [
            { id: "fundingProduct", value: "Balloon Financing Prof (compact cars)" },
            { id: "customerType", value: "business" },
            { id: "carPriceNet", value: "48500" },
            { id: "firstPayment", value: "12125" },
            { id: "duration", value: "60" },
            { id: "residualValue", value: "12125" }
        ],
        opaque: JSON.stringify({
            services: {},
            _engineId: 616957336,
            _downpayment: true,
            "_dp%": 0.25,
            _balloon: true,
            _carPrice: 58685,
            customerType: "business",
            fundingProduct: "Balloon Financing Prof (compact cars)",
            carPriceNet: "48500",
            firstPayment: "12125",
            duration: "60",
            residualValue: "12125"
        })
    };

    try {
        console.log("Calling FCIS API...");
        const res = await fetch(FCIS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                "Origin": "https://www.mercedes-benz.be",
                "Referer": "https://www.mercedes-benz.be/"
            },
            body: JSON.stringify(payload)
        });

        console.log("Status:", res.status);
        const text = await res.text();

        if (res.ok) {
            const data = JSON.parse(text);
            console.log("\n=== BALLOON FINANCING RESULTS ===");
            console.log("Monthly payment:", data.output?.rate);
            console.log("Interest rate:", data.output?.containers?.[1]?.items?.find(i => i.id === "anr")?.value);
            console.log("Duration:", data.output?.containers?.[1]?.items?.find(i => i.id === "numberInstallments")?.value);
            console.log("Down payment:", data.output?.containers?.[1]?.items?.find(i => i.id === "dpGross")?.value);
            console.log("Balloon:", data.output?.containers?.[1]?.items?.find(i => i.id === "rvBalloon")?.value);
            console.log("Total cost:", data.output?.containers?.[1]?.items?.find(i => i.id === "totalCost")?.value);
            console.log("\nAvailable products:", data.input?.items?.find(i => i.id === "fundingProduct")?.values?.map(v => v.label));
        } else {
            console.log("Error response:", text.substring(0, 500));
        }
    } catch (e) {
        console.error("Fetch error:", e.message);
    }
})();
