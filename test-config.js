const fs = require('fs');

(async () => {
    try {
        const url = "https://assets.oneweb.mercedes-benz.com/plugin/emh-dcps-mrktplc-vehicles-configuration/latest/ncos/prod/config_be.json";
        const res = await fetch(url);
        const json = await res.json();
        fs.writeFileSync("config_be.json", JSON.stringify(json, null, 2));
        console.log("Wrote config_be.json");

        // Let's quickly scan it for balloon or interest
        const str = JSON.stringify(json).toLowerCase();
        console.log("Has balloon?", str.includes('balloon') || str.includes('ballon'));
        console.log("Has interest?", str.includes('interest') || str.includes('rate'));

    } catch (e) {
        console.error(e);
    }
})();
