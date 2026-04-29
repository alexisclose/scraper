const query = `
query Introspection {
  __type(name: "VehicleClass") {
    name
    enumValues {
      name
    }
  }
  bodyType: __type(name: "BodyType") {
    name
    enumValues {
      name
    }
  }
}`;

(async () => {
    console.log("Fetching API schema...");
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
                query: query
            })
        });

        const status = res.status;
        const text = await res.text();
        console.log(`Status: ${status}`);
        if (status === 200) {
            console.log("Success! Data:");
            console.log(text);
        } else {
            console.log("Failed.");
            console.log(text.substring(0, 200));
        }
    } catch (err) {
        console.error(err);
    }
})();
