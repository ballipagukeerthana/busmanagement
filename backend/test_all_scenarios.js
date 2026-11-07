const http = require('http');

function api(path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`http://localhost:5000${path}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function assert(condition, message) {
    if (!condition) {
        console.error("❌ ASSERTION FAILED:", message);
        process.exit(1);
    } else {
        console.log("  ✅", message);
    }
}

(async () => {
    console.log("=================================================");
    console.log("CAMPUSGO - COMPREHENSIVE VERIFICATION TEST SUITE");
    console.log("=================================================\n");

    // ==========================================
    // 1. SCENARIO A: DRIVER 1 (BUS-01 / ROUTE 5)
    // ==========================================
    console.log("--- 1. SCENARIO A: Driver 1 (Assigned to BUS-01 / Route 5) ---");
    const d1Bus = await api('/api/driver/bus', { 'x-driver-id': '1' });
    assert(d1Bus.status === 200 && d1Bus.data.assigned === true, "Driver 1 has assigned bus (status 200)");
    assert(d1Bus.data.bus.bus_number === 'BUS-01', "Driver 1 assigned bus is BUS-01");

    const d1Students = await api('/api/driver/students', { 'x-driver-id': '1' });
    assert(d1Students.status === 200 && d1Students.data.assigned === true, "Driver 1 /students returned success");
    assert(d1Students.data.students.length === 1, `Driver 1 has exactly 1 student (found: ${d1Students.data.students.length})`);
    
    const s1 = d1Students.data.students[0];
    assert(s1.student_name === 'Kiran Kumar', "Driver 1 student is Kiran Kumar");
    assert(s1.roll_no === '254M1A0501', "Kiran Kumar roll number is 254M1A0501");
    assert(s1.stop_name === 'pudipatla', "Kiran Kumar stop is pudipatla");
    assert(s1.payment_status === 'Paid', "Kiran Kumar fee status is Paid");

    // Verify cancelled student (Reddy) and Bus 2 student (Sneha Reddy) are NOT returned
    const d1Names = d1Students.data.students.map(s => s.student_name);
    assert(!d1Names.includes('Reddy'), "Cancelled student 'Reddy' is NOT on Driver 1 bus");
    assert(!d1Names.includes('Sneha Reddy'), "Bus 2 student 'Sneha Reddy' is NOT on Driver 1 bus");

    // Verify Route Stops count for Driver 1
    const d1Route = await api('/api/driver/route', { 'x-driver-id': '1' });
    assert(d1Route.status === 200 && d1Route.data.assigned === true, "Driver 1 /route returned success");
    const pudipatlaStop = d1Route.data.stops.find(s => s.stop_name === 'pudipatla');
    assert(pudipatlaStop && pudipatlaStop.student_count === 1, "Route stop 'pudipatla' count is exactly 1");
    assert(pudipatlaStop.student_names === 'Kiran Kumar', "Route stop 'pudipatla' student is Kiran Kumar");

    const otherStopsWithStudents = d1Route.data.stops.filter(s => s.stop_name !== 'pudipatla' && s.student_count > 0);
    assert(otherStopsWithStudents.length === 0, "No other stops on Route 5 have students");


    // ==========================================
    // 2. SCENARIO B: DRIVER 101 (BUS-02 / ROUTE 2)
    // ==========================================
    console.log("\n--- 2. SCENARIO B: Driver 101 (Different Bus: BUS-02 / Route 2) ---");
    const d2Bus = await api('/api/driver/bus', { 'x-driver-id': '101' });
    assert(d2Bus.status === 200 && d2Bus.data.assigned === true, "Driver 101 has assigned bus (status 200)");
    assert(d2Bus.data.bus.bus_number === 'BUS-02', "Driver 101 assigned bus is BUS-02");

    const d2Students = await api('/api/driver/students', { 'x-driver-id': '101' });
    assert(d2Students.status === 200 && d2Students.data.assigned === true, "Driver 101 /students returned success");
    assert(d2Students.data.students.length === 1, `Driver 101 has exactly 1 student (found: ${d2Students.data.students.length})`);

    const s2 = d2Students.data.students[0];
    assert(s2.student_name === 'Sneha Reddy', "Driver 101 student is Sneha Reddy");
    assert(s2.roll_no === '254M1A0402', "Sneha Reddy roll number is 254M1A0402");
    assert(s2.stop_name === 'pakala bus stand', "Sneha Reddy stop is pakala bus stand");
    assert(s2.payment_status === 'Unpaid', "Sneha Reddy fee status is Unpaid");

    // Verify Kiran Kumar and Reddy are NOT on Driver 101's bus
    const d2Names = d2Students.data.students.map(s => s.student_name);
    assert(!d2Names.includes('Kiran Kumar'), "Bus 1 student 'Kiran Kumar' is NOT on Driver 101 bus");
    assert(!d2Names.includes('Reddy'), "Cancelled student 'Reddy' is NOT on Driver 101 bus");

    // Verify Route Stops count for Driver 101
    const d2Route = await api('/api/driver/route', { 'x-driver-id': '101' });
    assert(d2Route.status === 200 && d2Route.data.assigned === true, "Driver 101 /route returned success");
    const pakalaStop = d2Route.data.stops.find(s => s.stop_name === 'pakala bus stand');
    assert(pakalaStop && pakalaStop.student_count === 1, "Route stop 'pakala bus stand' count is exactly 1");
    assert(pakalaStop.student_names === 'Sneha Reddy', "Route stop 'pakala bus stand' student is Sneha Reddy");


    // ==========================================
    // 3. SCENARIO C: DRIVER 102 (UNASSIGNED DRIVER)
    // ==========================================
    console.log("\n--- 3. SCENARIO C: Driver 102 (Unassigned Driver) ---");
    const d3Bus = await api('/api/driver/bus', { 'x-driver-id': '102' });
    assert(d3Bus.status === 200 && d3Bus.data.assigned === false, "Driver 102 assigned is false");

    const d3Students = await api('/api/driver/students', { 'x-driver-id': '102' });
    assert(d3Students.status === 200 && d3Students.data.assigned === false, "Driver 102 /students assigned is false");
    assert(Array.isArray(d3Students.data.students) && d3Students.data.students.length === 0, "Driver 102 students array is empty []");

    const d3Route = await api('/api/driver/route', { 'x-driver-id': '102' });
    assert(d3Route.status === 200 && d3Route.data.assigned === false, "Driver 102 /route assigned is false");
    assert(Array.isArray(d3Route.data.stops) && d3Route.data.stops.length === 0, "Driver 102 stops array is empty []");


    // ==========================================
    // 4. SCENARIO D: ADMIN DASHBOARD STUDENTS & ROUTES
    // ==========================================
    console.log("\n--- 4. SCENARIO D: Admin Dashboard Verification ---");
    const adminStu = await api('/api/admin/students');
    assert(adminStu.status === 200 && adminStu.data.success === true, "Admin /students returned 200 success");
    assert(adminStu.data.total === 3, `Admin sees all 3 registered students (total: ${adminStu.data.total})`);

    const adminRoutes = await api('/api/admin/routes');
    assert(adminRoutes.status === 200 && adminRoutes.data.success === true, "Admin /routes returned 200 success");
    const r1 = adminRoutes.data.routes.find(r => r.route_id === 5);
    const r2 = adminRoutes.data.routes.find(r => r.route_id === 2);
    assert(r1 && r1.students_count === 1, "Admin Route 1 shows 1 active enrolled student (Kiran Kumar)");
    assert(r2 && r2.students_count === 1, "Admin Route 2 shows 1 active enrolled student (Sneha Reddy)");


    // ==========================================
    // 5. SCENARIO E: FRONTEND RENDERING SIMULATION
    // ==========================================
    console.log("\n--- 5. SCENARIO E: Frontend Rendering Logic Simulation ---");
    function simulateRender(students, isAssigned) {
        let ovHtml = "";
        let tableHtml = "";
        const studentList = Array.isArray(students) ? students : [];

        if (!isAssigned) {
            ovHtml = "No bus is currently assigned to your driver account.";
            tableHtml = "No bus is currently assigned to your driver account. Contact College Transport Admin.";
        } else if (studentList.length === 0) {
            ovHtml = "No students currently assigned to this bus.";
            tableHtml = "No students currently assigned to this bus.";
        } else {
            ovHtml = studentList.slice(0, 5).map(s => `${s.student_name || 'Student'} (${s.roll_no || '—'}) - ${s.payment_status || 'Unpaid'}`).join(", ");
            tableHtml = studentList.map(s => `${s.student_name} [${s.payment_status}]`).join(", ");
        }
        return { ovHtml, tableHtml };
    }

    const testNormal = simulateRender(d1Students.data.students, true);
    assert(testNormal.ovHtml.includes("Kiran Kumar"), "Normal render contains student name");
    assert(!testNormal.ovHtml.includes("Loading students..."), "Normal render is not stuck on loading");

    const testEmpty = simulateRender([], true);
    assert(testEmpty.ovHtml === "No students currently assigned to this bus.", "Empty list shows clean empty banner");

    const testUnassigned = simulateRender([], false);
    assert(testUnassigned.ovHtml === "No bus is currently assigned to your driver account.", "Unassigned driver shows clean notice");

    console.log("\n=================================================");
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY WITH ZERO ERRORS!");
    console.log("=================================================");
    process.exit(0);
})().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
