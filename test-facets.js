const query = `
query GetFacets {
  search(
    language: "nl"
    limit: 1
    profileId: "BE-NEW_VEHICLES"
    sortingType: "price-asc"
    contextType: B2C
    page: 0
    vehicleCategory: "PASSENGER-CARS"
  ) {
    facets {
      modelIdentifier {
        ... on FormattedValueFacet {
          values {
            value
            label
          }
        }
      }
      bodyType {
        ... on FormattedValueFacet {
          values {
            value
            label
          }
        }
      }
    }
  }
}`;

(async () => {
    console.log("Fetching API facets...");
    try {
        const res = await fetch("https://eu.api.oneweb.mercedes-benz.com/commerce/onesearch/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": "d1dcd3a9-25fd-4896-b041-4d35cfdbb482",
                "user-agent": "Mozilla/5.0",
                "accept": "*/*",
                "referer": "https://www.mercedes-benz.be/"
            },
            body: JSON.stringify({
                query: query
            })
        });

        const status = res.status;
        const text = await res.text();
        console.log(`Status: ${status}`);
        if (status === 200) {
            const data = JSON.parse(text);
            console.log("Models:");
            const models = data.data.search.facets.modelIdentifier.values;
            models.slice(0, 10).forEach(v => console.log(v.value, "=>", v.label));
            console.log("...");
            console.log("\nBody types:");
            const bodies = data.data.search.facets.bodyType.values;
            bodies.forEach(v => console.log(v.value, "=>", v.label));
        } else {
            console.log("Failed.");
            console.log(text.substring(0, 200));
        }
    } catch (err) {
        console.error(err);
    }
})();
