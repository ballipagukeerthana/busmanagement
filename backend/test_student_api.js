const http = require('http');

function apiCall(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(`http://localhost:5000/api/student${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-student-id': '1'
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch(e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runTests() {
    console.log("=== Testing Student API Endpoints ===");

    // 1. Dashboard summary
    const sum = await apiCall('/dashboard-summary');
    console.log("1. /dashboard-summary:", sum.status, "Success:", sum.data && sum.data.success);
    if (sum.data && sum.data.student) {
        console.log("   Student:", sum.data.student.name, "(Roll:", sum.data.student.roll_no, ")");
        console.log("   Route:", sum.data.transport ? sum.data.transport.route_name : "None");
        console.log("   Fee:", sum.data.fee);
    }

    // 2. Profile
    const prof = await apiCall('/profile');
    console.log("2. /profile:", prof.status, "Student:", prof.data && prof.data.student ? prof.data.student.name : "None");

    // 3. Restricted profile editing test: Try updating name and phone (valid)
    const editValid = await apiCall('/profile', 'PATCH', {
        name: "Reddy",
        phone_no: "9863686258"
    });
    console.log("3. /profile PATCH (valid):", editValid.status, "Message:", editValid.data && editValid.data.message);

    // 4. Restricted profile editing test: Try updating invalid phone
    const editInvalid = await apiCall('/profile', 'PATCH', {
        name: "Reddy",
        phone_no: "123" // Invalid, not 10 digits
    });
    console.log("4. /profile PATCH (invalid phone):", editInvalid.status, "Success:", editInvalid.data && editInvalid.data.success, "Msg:", editInvalid.data && editInvalid.data.message);

    // 5. Route details
    const route = await apiCall('/route');
    console.log("5. /route:", route.status, "Route:", route.data && route.data.route ? route.data.route.route_name : "None", "Stops count:", route.data && route.data.stops ? route.data.stops.length : 0);

    // 6. Driver & Bus details
    const driverBus = await apiCall('/driver-bus');
    console.log("6. /driver-bus:", driverBus.status, "Bus:", driverBus.data && driverBus.data.bus ? driverBus.data.bus.bus_number : "None", "Driver:", driverBus.data && driverBus.data.driver ? driverBus.data.driver.name : "None");

    // 7. Fee & Payments
    const fee = await apiCall('/fee');
    console.log("7. /fee:", fee.status, "Outstanding:", fee.data && fee.data.fee ? fee.data.fee.outstanding_amount : "None", "Payments:", fee.data && fee.data.payments ? fee.data.payments.length : 0);

    // 8. Receipts
    const recs = await apiCall('/receipts');
    console.log("8. /receipts:", recs.status, "Receipts count:", recs.data && recs.data.receipts ? recs.data.receipts.length : 0);

    // 9. Bus Request & Pass
    const pass = await apiCall('/bus-request');
    console.log("9. /bus-request:", pass.status, "Pass #:", pass.data && pass.data.pass ? pass.data.pass.pass_number : "None");

    // 10. Live Tracking
    const tracking = await apiCall('/live-tracking');
    console.log("10. /live-tracking:", tracking.status, "On trip:", tracking.data && tracking.data.is_on_trip, "Bus:", tracking.data ? tracking.data.bus_number : "None");

    // 11. Available Routes
    const avail = await apiCall('/available-routes');
    console.log("11. /available-routes:", avail.status, "Available routes count:", avail.data && avail.data.routes ? avail.data.routes.length : 0);

    console.log("=== All API Tests Completed ===");
}

runTests().catch(console.error);
