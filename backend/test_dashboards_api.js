const http = require('http');

function request(path, headers = {}) {
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

(async () => {
    console.log("=== Testing API Endpoints ===");

    // 1. Admin Students
    const adminStudents = await request('/api/admin/students');
    console.log("\n1. /api/admin/students:", adminStudents.status);
    if (adminStudents.data && adminStudents.data.students) {
        console.log("   Total students:", adminStudents.data.total);
        adminStudents.data.students.forEach(s => {
            console.log(`   Student: ${s.name} (${s.roll_no}) | Route: ${s.route_name} | Stop: ${s.stop_name} | Bus: ${s.bus_number} | Fee: ${s.fee_status} (Paid: ₹${s.total_paid} / ₹${s.applicable_fee})`);
        });
    }

    // 2. Admin Routes
    const adminRoutes = await request('/api/admin/routes');
    console.log("\n2. /api/admin/routes:", adminRoutes.status);
    if (adminRoutes.data && adminRoutes.data.routes) {
        adminRoutes.data.routes.forEach(r => {
            console.log(`   Route: ${r.route_name} | Stops: ${r.stops_count} | Enrolled students: ${r.students_count} | Bus: ${r.assigned_buses}`);
        });
    }

    // 3. Admin Fee Assignments
    const feeAssignments = await request('/api/admin/fee-assignments');
    console.log("\n3. /api/admin/fee-assignments:", feeAssignments.status);
    if (feeAssignments.data && feeAssignments.data.assignments) {
        console.log("   Assignments count:", feeAssignments.data.total);
        feeAssignments.data.assignments.forEach(fa => {
            console.log(`   Student: ${fa.student_name} (${fa.roll_no}) | Stop: ${fa.stop_name} | Fee: ₹${fa.applicable_fee} | Paid: ₹${fa.total_paid} | Status: ${fa.status}`);
        });
    }

    // 4. Driver 1 (vijay kumar - BUS-01) Students
    const driver1Students = await request('/api/driver/students', { 'x-driver-id': '1' });
    console.log("\n4. /api/driver/students (Driver 1 - BUS-01):", driver1Students.status);
    if (driver1Students.data) {
        console.log("   Assigned:", driver1Students.data.assigned, "Bus:", driver1Students.data.bus_number, "Total students:", driver1Students.data.students?.length);
        driver1Students.data.students?.forEach(s => {
            console.log(`   Student on this bus: ${s.student_name} (${s.roll_no}) | Stop: ${s.stop_name} | Fee: ${s.payment_status} (Paid: ₹${s.verified_paid} / ₹${s.fee_amount})`);
        });
    }

    // 5. Driver 1 (vijay kumar - BUS-01) Route & Stops
    const driver1Route = await request('/api/driver/route', { 'x-driver-id': '1' });
    console.log("\n5. /api/driver/route (Driver 1 - BUS-01):", driver1Route.status);
    if (driver1Route.data && driver1Route.data.stops) {
        console.log("   Route:", driver1Route.data.route?.route_name);
        driver1Route.data.stops.forEach(st => {
            if (st.student_count > 0) {
                console.log(`   Stop #${st.stop_order} ${st.stop_name}: ${st.student_count} student(s) (${st.student_names})`);
            }
        });
    }

    // 6. Driver 2 (ramesh kumar - BUS-02) Students (Should NOT see Reddy)
    const driver2Students = await request('/api/driver/students', { 'x-driver-id': '101' });
    console.log("\n6. /api/driver/students (Driver 101 - BUS-02):", driver2Students.status);
    if (driver2Students.data) {
        console.log("   Assigned:", driver2Students.data.assigned, "Bus:", driver2Students.data.bus_number, "Total students:", driver2Students.data.students?.length);
    }

    // 7. Student 1 Dashboard Summary
    const studentSummary = await request('/api/student/dashboard-summary', { 'x-student-id': '1' });
    console.log("\n7. /api/student/dashboard-summary (Student 1):", studentSummary.status);
    if (studentSummary.data && studentSummary.data.student) {
        console.log("   Student:", studentSummary.data.student.name, "| Route:", studentSummary.data.transport?.route_name, "| Bus:", studentSummary.data.transport?.bus_number, "| Fee:", studentSummary.data.fee?.payment_status);
    }

    console.log("\n=== Testing Complete ===");
    process.exit(0);
})().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
