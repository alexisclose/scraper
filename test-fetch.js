const query = `
query GetSearchResults($language: String, $limit: Int!, $profileId: String!, $sortingType: String!, $contextType: ContextType!, $page: Int!, $vehicleCategory: String!, $modelIdentifier: [VehicleClass!], $bodyType: [BodyType!]) {
  search(
    language: $language
    limit: $limit
    profileId: $profileId
    sortingType: $sortingType
    contextType: $contextType
    page: $page
    vehicleCategory: $vehicleCategory
    modelIdentifier: $modelIdentifier
    bodyType: $bodyType
  ) {
    facets {
      monthlyRate {
        ... on RangeFacet {
          values {
            min
            max
            count
          }
          facetType
        }
      }
    }
  }
}`;

const variables = {
  "limit": 12,
  "sortingType": "price-asc",
  "contextType": "B2C",
  "page": 0,
  "language": "nl",
  "profileId": "BE-NEW_VEHICLES",
  "vehicleCategory": "PASSENGER-CARS",
  "modelIdentifier": ["C"],
  "bodyType": ["LIMOUSINE"]
};

(async () => {
  console.log("Fetching API directly...");
  try {
    const res = await fetch("https://eu.api.oneweb.mercedes-benz.com/commerce/onesearch/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "d1dcd3a9-25fd-4896-b041-4d35cfdbb482",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept": "*/*",
        "referer": "https://www.mercedes-benz.be/"
      },
      body: JSON.stringify({
        operationName: "GetSearchResults",
        variables: variables,
        query: query
      })
    });

    const status = res.status;
    const text = await res.text();
    console.log(`Status: ${status}`);
    if (status === 200) {
      console.log("Success! Data:");
      console.log(text.substring(0, 500));
    } else {
      console.log("Failed. Cloudflare might have blocked it.");
      console.log(text.substring(0, 200));
    }
  } catch (err) {
    console.error(err);
  }
})();
