const fs = require("fs");
const path = require("path");
const assert = require("assert");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.join(__dirname, ".env") });

async function runTests() {
    console.log("=== STARTING VALIDATION OF THE 4 CHANGES ===");

    const pool = await mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: Number(process.env.DB_PORT) || 3306
    });

    // Pick an existing student for testing
    const [students] = await pool.query("SELECT student_id, name, roll_no FROM students LIMIT 1");
    assert(students.length > 0, "At least one student should exist in DB");
    const testStudent = students[0];
    const studentId = testStudent.student_id;
    console.log(`Using test student ID: ${studentId} (${testStudent.name})`);

    // Pick an active route and stop
    const [stops] = await pool.query("SELECT route_id, stop_id FROM route_stops LIMIT 1");
    assert(stops.length > 0, "At least one stop should exist in DB");
    const testRouteId = stops[0].route_id;
    const testStopId = stops[0].stop_id;

    // ==========================================
    // CHANGE 1 VALIDATION: Student Bus Pass Photo
    // ==========================================
    console.log("\n--- Testing CHANGE 1: Passport photo upload for bus pass request ---");
    
    // 1.1: Submit without photo -> expect 400
    const formNoPhoto = new FormData();
    formNoPhoto.append("route_id", String(testRouteId));
    formNoPhoto.append("stop_id", String(testStopId));
    
    const resNoPhoto = await fetch("http://localhost:5000/api/student/bus-request", {
        method: "POST",
        headers: { "x-student-id": String(studentId) },
        body: formNoPhoto
    });
    const dataNoPhoto = await resNoPhoto.json();
    assert.strictEqual(resNoPhoto.status, 400, "Should reject missing photo with 400");
    assert(dataNoPhoto.message.includes("photo"), "Message should mention photo requirement");
    console.log("✓ Correctly rejected bus pass request without photo (400)");

    // 1.2: Submit with wrong file type -> expect 400
    const formWrongType = new FormData();
    formWrongType.append("route_id", String(testRouteId));
    formWrongType.append("stop_id", String(testStopId));
    const txtBlob = new Blob(["not an image"], { type: "text/plain" });
    formWrongType.append("passport_photo", txtBlob, "document.txt");

    const resWrongType = await fetch("http://localhost:5000/api/student/bus-request", {
        method: "POST",
        headers: { "x-student-id": String(studentId) },
        body: formWrongType
    });
    const dataWrongType = await resWrongType.json();
    assert.strictEqual(resWrongType.status, 400, "Should reject text file with 400");
    console.log("✓ Correctly rejected invalid file format (400)");

    // 1.3: Submit with oversized photo (> 2MB) -> expect 400
    const formBigPhoto = new FormData();
    formBigPhoto.append("route_id", String(testRouteId));
    formBigPhoto.append("stop_id", String(testStopId));
    const bigBuffer = new Uint8Array(2.5 * 1024 * 1024);
    const bigBlob = new Blob([bigBuffer], { type: "image/jpeg" });
    formBigPhoto.append("passport_photo", bigBlob, "large_photo.jpg");

    const resBigPhoto = await fetch("http://localhost:5000/api/student/bus-request", {
        method: "POST",
        headers: { "x-student-id": String(studentId) },
        body: formBigPhoto
    });
    const dataBigPhoto = await resBigPhoto.json();
    assert.strictEqual(resBigPhoto.status, 400, "Should reject >2MB photo with 400");
    console.log("✓ Correctly rejected photo > 2MB (400)");

    // 1.4: Submit with valid 1x1 PNG image
    // Clear any pending request for this student first to avoid 409
    await pool.query("DELETE FROM bus_pass_requests WHERE student_id = ? AND status = 'Pending'", [studentId]);

    const formValid = new FormData();
    formValid.append("route_id", String(testRouteId));
    formValid.append("stop_id", String(testStopId));
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    const pngBlob = new Blob([pngBuffer], { type: "image/png" });
    formValid.append("passport_photo", pngBlob, "test_passport.png");

    const resValid = await fetch("http://localhost:5000/api/student/bus-request", {
        method: "POST",
        headers: { "x-student-id": String(studentId) },
        body: formValid
    });
    const dataValid = await resValid.json();
    assert.strictEqual(resValid.status, 201, "Should succeed with 201");
    assert(dataValid.success, "Should return success: true");

    // Check DB record for saved passport_photo path
    const [passReqs] = await pool.query(
        "SELECT request_id, passport_photo FROM bus_pass_requests WHERE student_id = ? ORDER BY request_id DESC LIMIT 1",
        [studentId]
    );
    assert(passReqs.length > 0, "Pass request must exist in DB");
    assert(passReqs[0].passport_photo, "passport_photo column must not be null");
    assert(passReqs[0].passport_photo.startsWith("/uploads/passport-photos/"), "Path should start with /uploads/passport-photos/");
    console.log("✓ Passport photo path saved in DB:", passReqs[0].passport_photo);

    // Verify static file serving for passport photos
    const staticUrl = `http://localhost:5000${passReqs[0].passport_photo}`;
    const resStatic = await fetch(staticUrl);
    assert.strictEqual(resStatic.status, 200, "Static passport photo must be accessible via GET");
    console.log("✓ Passport photo served statically at:", staticUrl);

    // ==========================================
    // CHANGE 2 VALIDATION: Driver License Upload & Admin Protection
    // ==========================================
    console.log("\n--- Testing CHANGE 2: Driver license photo upload and admin protection ---");

    const uniquePhone = "9" + Math.floor(100000000 + Math.random() * 900000000);
    const uniqueEmail = `driver_${Date.now()}@campusgo.com`;
    const uniqueLicense = "DL" + Math.floor(1000000 + Math.random() * 9000000);

    // 2.1: Register driver without license photo -> expect 400
    const formDriverNoFile = new FormData();
    formDriverNoFile.append("name", "Test Driver");
    formDriverNoFile.append("phone_no", uniquePhone);
    formDriverNoFile.append("email", uniqueEmail);
    formDriverNoFile.append("license_no", uniqueLicense);
    formDriverNoFile.append("experience", "5");
    formDriverNoFile.append("password", "DriverPass@123");
    formDriverNoFile.append("confirm_password", "DriverPass@123");

    const resDriverNoFile = await fetch("http://localhost:5000/api/drivers/register", {
        method: "POST",
        body: formDriverNoFile
    });
    const dataDriverNoFile = await resDriverNoFile.json();
    assert.strictEqual(resDriverNoFile.status, 400, "Should reject driver without license photo");
    assert(dataDriverNoFile.message.includes("licence photo"), "Message should mention licence photo");
    console.log("✓ Correctly rejected driver registration without licence photo (400)");

    // 2.2: Register driver with file > 5MB -> expect 400
    const formDriverBigFile = new FormData();
    formDriverBigFile.append("name", "Test Driver");
    formDriverBigFile.append("phone_no", uniquePhone);
    formDriverBigFile.append("email", uniqueEmail);
    formDriverBigFile.append("license_no", uniqueLicense);
    formDriverBigFile.append("experience", "5");
    formDriverBigFile.append("password", "DriverPass@123");
    formDriverBigFile.append("confirm_password", "DriverPass@123");
    const bigLicense = new Blob([new Uint8Array(5.5 * 1024 * 1024)], { type: "application/pdf" });
    formDriverBigFile.append("license_photo", bigLicense, "huge_license.pdf");

    const resDriverBig = await fetch("http://localhost:5000/api/drivers/register", {
        method: "POST",
        body: formDriverBigFile
    });
    const dataDriverBig = await resDriverBig.json();
    assert.strictEqual(resDriverBig.status, 400, "Should reject file > 5MB");
    console.log("✓ Correctly rejected licence file > 5MB (400)");

    // 2.3: Register driver with valid license file -> expect 201
    const formDriverValid = new FormData();
    formDriverValid.append("name", "Valid Test Driver");
    formDriverValid.append("phone_no", uniquePhone);
    formDriverValid.append("email", uniqueEmail);
    formDriverValid.append("license_no", uniqueLicense);
    formDriverValid.append("experience", "7");
    formDriverValid.append("password", "DriverPass@123");
    formDriverValid.append("confirm_password", "DriverPass@123");
    const validLicenseBlob = new Blob([Buffer.from("%PDF-1.4 test pdf content", "utf-8")], { type: "application/pdf" });
    formDriverValid.append("license_photo", validLicenseBlob, "valid_license.pdf");

    const resDriverValid = await fetch("http://localhost:5000/api/drivers/register", {
        method: "POST",
        body: formDriverValid
    });
    const dataDriverValid = await resDriverValid.json();
    assert.strictEqual(resDriverValid.status, 201, "Driver registration should succeed with 201");
    assert(dataDriverValid.success, "Driver registration success must be true");

    // Check DB record for saved license_photo
    const [drvReqs] = await pool.query(
        "SELECT request_id, license_photo FROM driver_requests WHERE email = ? LIMIT 1",
        [uniqueEmail]
    );
    assert(drvReqs.length > 0, "Driver request must exist in DB");
    assert(drvReqs[0].license_photo, "license_photo must not be null");
    assert(drvReqs[0].license_photo.startsWith("/uploads/licenses/"), "Path should start with /uploads/licenses/");
    console.log("✓ Driver licence photo saved in DB:", drvReqs[0].license_photo);

    // 2.4: Test Access Control: Licence photo only accessible to logged-in admin
    const licenseUrl = `http://localhost:5000${drvReqs[0].license_photo}`;
    
    // Unauthorized access (no admin headers) -> expect 403 Forbidden
    const resUnauthLicense = await fetch(licenseUrl);
    assert.strictEqual(resUnauthLicense.status, 403, "Public or non-admin access to license photo must return 403");
    console.log("✓ Public/unauthorized access to licence photo correctly returned 403 Forbidden");

    // Authorized access (with x-admin-role: admin) -> expect 200 OK
    const resAdminHeader = await fetch(licenseUrl, {
        headers: { "x-admin-role": "admin" }
    });
    assert.strictEqual(resAdminHeader.status, 200, "Admin header access must return 200 OK");
    console.log("✓ Admin access to licence photo with x-admin-role header returned 200 OK");

    // Authorized access (with referer admin-dashboard.html) -> expect 200 OK
    const resAdminReferer = await fetch(licenseUrl, {
        headers: { "referer": "http://localhost:5000/pages/admin-dashboard.html" }
    });
    assert.strictEqual(resAdminReferer.status, 200, "Admin referer access must return 200 OK");
    console.log("✓ Admin access to licence photo from admin dashboard returned 200 OK");

    // ==========================================
    // CHANGE 3 VALIDATION: "My Receipt" removed from student navigation
    // ==========================================
    console.log("\n--- Testing CHANGE 3: Navigation menu verified ---");
    const studentHtml = fs.readFileSync(path.join(__dirname, "../frontend/pages/student-dashboard.html"), "utf8");
    const navMatch = studentHtml.match(/<nav class="sidebar-nav">([\s\S]*?)<\/nav>/);
    assert(navMatch, "sidebar-nav must exist in student-dashboard.html");
    const navContent = navMatch[1];
    assert(!navContent.toLowerCase().includes("receipt"), "sidebar-nav must NOT contain any receipt link or text");
    assert(studentHtml.includes('id="view-receipt"'), "view-receipt section must remain intact");
    console.log("✓ Verified: 'My Receipt' is completely absent from student sidebar-nav, while receipt view remains intact.");

    // ==========================================
    // CHANGE 4 VALIDATION: Cancelled bus pass inactive profile & live tracking gating
    // ==========================================
    console.log("\n--- Testing CHANGE 4: Cancelled bus pass accounts and live tracking 403 gating ---");

    // Ensure student has a bus pass
    const [existingPasses] = await pool.query("SELECT pass_id, status FROM bus_passes WHERE student_id = ? ORDER BY pass_id DESC LIMIT 1", [studentId]);
    let testPassId;
    if (existingPasses.length > 0) {
        testPassId = existingPasses[0].pass_id;
    } else {
        const [pRes] = await pool.query(
            "INSERT INTO bus_passes (student_id, roll_no, stop_name, route_name, bus_number, amount_paid, pass_number, valid_from, valid_to, status, created_at) VALUES (?, ?, 'Main Gate', 'Route 1', 'BUS-01', 12000, 'TEST-PASS-01', CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 YEAR), 'Active', NOW())",
            [studentId, testStudent.roll_no]
        );
        testPassId = pRes.insertId;
    }

    // Set pass to 'Active'
    await pool.query("UPDATE bus_passes SET status = 'Active' WHERE pass_id = ?", [testPassId]);
    await pool.query("UPDATE student_transport SET status = 'Active' WHERE student_id = ?", [studentId]);
    await pool.query("DELETE FROM transport_cancellations WHERE student_id = ?", [studentId]);

    // Active status check
    const resSummaryActive = await fetch("http://localhost:5000/api/student/dashboard-summary", {
        headers: { "x-student-id": String(studentId) }
    });
    const dataSummaryActive = await resSummaryActive.json();
    assert.strictEqual(dataSummaryActive.is_profile_inactive, false, "Active student profile must have is_profile_inactive = false");
    console.log("✓ Active student has is_profile_inactive = false");

    // Now Cancel the pass
    await pool.query("UPDATE bus_passes SET status = 'Cancelled' WHERE pass_id = ?", [testPassId]);
    await pool.query("UPDATE student_transport SET status = 'Cancelled' WHERE student_id = ?", [studentId]);

    // Cancelled status check on /dashboard-summary
    const resSummaryCancelled = await fetch("http://localhost:5000/api/student/dashboard-summary", {
        headers: { "x-student-id": String(studentId) }
    });
    const dataSummaryCancelled = await resSummaryCancelled.json();
    assert.strictEqual(dataSummaryCancelled.is_profile_inactive, true, "Cancelled student profile must have is_profile_inactive = true");
    console.log("✓ Cancelled student has is_profile_inactive = true in dashboard summary");

    // Cancelled status check on /live-tracking -> MUST return 403 Forbidden
    const resTrackCancelled = await fetch("http://localhost:5000/api/student/live-tracking", {
        headers: { "x-student-id": String(studentId) }
    });
    assert.strictEqual(resTrackCancelled.status, 403, "Live tracking for cancelled pass student must return 403");
    const dataTrackCancelled = await resTrackCancelled.json();
    assert.strictEqual(dataTrackCancelled.success, false, "Live tracking success must be false");
    assert(dataTrackCancelled.message.includes("cancelled"), "Live tracking message must mention cancelled pass");
    console.log("✓ Live tracking API correctly returned 403 Forbidden:", dataTrackCancelled.message);

    // Reactivate pass -> must automatically restore access
    await pool.query("UPDATE bus_passes SET status = 'Active' WHERE pass_id = ?", [testPassId]);
    await pool.query("UPDATE student_transport SET status = 'Active' WHERE student_id = ?", [studentId]);

    const resSummaryRestored = await fetch("http://localhost:5000/api/student/dashboard-summary", {
        headers: { "x-student-id": String(studentId) }
    });
    const dataSummaryRestored = await resSummaryRestored.json();
    assert.strictEqual(dataSummaryRestored.is_profile_inactive, false, "Reactivated pass must automatically set is_profile_inactive = false");

    const resTrackRestored = await fetch("http://localhost:5000/api/student/live-tracking", {
        headers: { "x-student-id": String(studentId) }
    });
    assert.notStrictEqual(resTrackRestored.status, 403, "Reactivated student must not get 403 on live tracking");
    console.log("✓ When pass is reactivated, normal status automatically returns (no 403)");

    await pool.end();
    console.log("\n=== ALL 4 CHANGES TESTED AND VERIFIED SUCCESSFULLY! ===");
}

runTests().catch(err => {
    console.error("Test failure:", err);
    process.exit(1);
});
