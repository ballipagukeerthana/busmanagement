"use strict";

const express = require("express");
const bcrypt = require("bcrypt");

/**
 * Distance fee slab calculation helper (VEMU IT pricing rules)
 * Slabs:
 *   0  - 5  km: ₹8,000
 *   5.1 - 10 km: ₹11,000
 *   10.1 - 15 km: ₹14,000
 *   15.1 - 20 km: ₹16,000
 *   20.1 - 25 km: ₹18,000
 *   25.1 - 30 km: ₹20,000
 *   > 30 km: ₹22,000
 */
const FEE_SLABS = [
    { maxKm: 5, fee: 8000, label: "0 – 5 km" },
    { maxKm: 10, fee: 11000, label: "5.1 – 10 km" },
    { maxKm: 15, fee: 14000, label: "10.1 – 15 km" },
    { maxKm: 20, fee: 16000, label: "15.1 – 20 km" },
    { maxKm: 25, fee: 18000, label: "20.1 – 25 km" },
    { maxKm: 30, fee: 20000, label: "25.1 – 30 km" },
    { maxKm: Infinity, fee: 22000, label: "Above 30 km" }
];

function calculateDistanceFee(distanceKm) {
    const km = Number(distanceKm) || 0;
    if (km <= 0) return 8000;
    for (const slab of FEE_SLABS) {
        if (km <= slab.maxKm) {
            return slab.fee;
        }
    }
    return 22000;
}

function registerAdminRoutes(app, db, io, broadcastStatistics, handleLicenseUpload) {
    const router = express.Router();

    // ==========================================
    // 1. DASHBOARD STATISTICS
    // ==========================================
    router.get("/stats", async (req, res) => {
        try {
            const [
                [buses],
                [routes],
                [students],
                [allStudents],
                [drivers],
                [stops],
                [pendingPassRequests],
                [pendingDriverRequests],
                [approvedPassRequests],
                [pendingPayments],
                [successfulPayments],
                [completedTrips],
                [startedTrips],
                [activeBuses],
                [workingBuses],
                [notWorkingBuses],
                [availableBuses],
                [totalPasses],
                [unreadMessages]
            ] = await Promise.all([
                db.query("SELECT COUNT(*) AS total FROM buses"),
                db.query("SELECT COUNT(*) AS total FROM routes WHERE status = 'Active'"),
                db.query("SELECT COUNT(*) AS total FROM students WHERE status = 'active'"),
                db.query("SELECT COUNT(*) AS total FROM students"),
                db.query("SELECT COUNT(*) AS total FROM drivers WHERE status = 'Active'"),
                db.query("SELECT COUNT(*) AS total FROM stops WHERE status = 'Active'"),
                db.query("SELECT COUNT(*) AS total FROM bus_pass_requests WHERE status = 'Pending'"),
                db.query("SELECT COUNT(*) AS total FROM driver_requests WHERE status = 'Pending'"),
                db.query("SELECT COUNT(*) AS total FROM bus_pass_requests WHERE status = 'Approved'"),
                db.query("SELECT COUNT(*) AS total FROM payments WHERE payment_status = 'Pending'"),
                db.query("SELECT COUNT(*) AS total FROM payments WHERE payment_status = 'Success'"),
                db.query("SELECT COUNT(*) AS total FROM trips WHERE status = 'Completed'"),
                db.query("SELECT COUNT(*) AS total FROM trips WHERE status = 'Started'"),
                db.query("SELECT COUNT(*) AS total FROM buses WHERE status = 'Active'"),
                db.query("SELECT COUNT(*) AS total FROM buses WHERE status IN ('Active', 'Available')"),
                db.query("SELECT COUNT(*) AS total FROM buses WHERE status NOT IN ('Active', 'Available')"),
                db.query("SELECT COUNT(*) AS total FROM buses WHERE status IN ('Active', 'Available') AND bus_id NOT IN (SELECT bus_id FROM trips WHERE status = 'Started')"),
                db.query("SELECT COUNT(*) AS total FROM bus_passes"),
                db.query("SELECT COUNT(*) AS total FROM contact_messages WHERE is_read = 0").catch(() => [[{ total: 0 }]])
            ]);

            res.json({
                success: true,
                totalBuses: Number(buses[0].total),
                totalRoutes: Number(routes[0].total),
                totalStudents: Number(students[0].total),
                totalAllStudents: Number(allStudents[0].total),
                totalDrivers: Number(drivers[0].total),
                totalStops: Number(stops[0].total),
                pendingRequests: Number(pendingPassRequests[0].total),
                approvedRequests: Number(approvedPassRequests[0].total),
                pendingDriverRequests: Number(pendingDriverRequests[0].total),
                pendingPayments: Number(pendingPayments[0].total),
                successfulPayments: Number(successfulPayments[0].total),
                completedTrips: Number(completedTrips[0].total),
                startedTrips: Number(startedTrips[0].total),
                activeBuses: Number(activeBuses[0].total),
                workingBuses: Number(workingBuses[0].total),
                notWorkingBuses: Number(notWorkingBuses[0].total),
                availableBuses: Number(availableBuses[0].total),
                pendingPassRequests: Number(pendingPassRequests[0].total),
                totalGeneratedPasses: Number(totalPasses[0].total),
                unreadContactMessages: Number((unreadMessages && unreadMessages[0] && unreadMessages[0].total) || 0)
            });
        } catch (error) {
            console.error("Admin stats error:", error.message);
            res.status(500).json({ success: false, message: "Unable to load dashboard statistics." });
        }
    });

    // ==========================================
    // 2. DRIVER REQUESTS
    // ==========================================
    router.get("/driver-requests", async (req, res) => {
        try {
            const [requests] = await db.query(`
                SELECT
                    request_id AS id,
                    name,
                    phone_no AS phone,
                    email,
                    license_no AS licence,
                    experience,
                    license_photo,
                    status,
                    requested_at AS date,
                    reviewed_at
                FROM driver_requests
                ORDER BY
                    CASE WHEN status = 'Pending' THEN 0 ELSE 1 END,
                    requested_at DESC
            `);

            res.json({
                success: true,
                requests: requests.map(r => ({
                    id: r.id,
                    name: r.name,
                    phone: r.phone,
                    email: r.email,
                    licence: r.licence,
                    license_photo: r.license_photo || null,
                    experience: r.experience,
                    date: r.date,
                    reviewed_at: r.reviewed_at,
                    status: r.status
                }))
            });
        } catch (error) {
            console.error("Admin driver requests error:", error.message);
            res.status(500).json({ success: false, message: "Unable to load driver requests." });
        }
    });

    router.get("/driver-requests/:id", async (req, res) => {
        try {
            const requestId = Number(req.params.id);
            const [rows] = await db.query(
                "SELECT request_id AS id, name, phone_no AS phone, email, license_no AS licence, experience, license_photo, status, requested_at AS date, reviewed_at FROM driver_requests WHERE request_id = ?",
                [requestId]
            );
            if (!rows.length) {
                return res.status(404).json({ success: false, message: "Driver request not found." });
            }
            res.json({ success: true, request: rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.patch("/driver-requests/:id/status", async (req, res) => {
        let connection;
        try {
            const requestId = Number(req.params.id);
            const { status, salary, experience } = req.body;

            if (!["Approved", "Rejected"].includes(status)) {
                return res.status(400).json({ success: false, message: "Status must be Approved or Rejected." });
            }

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [requests] = await connection.execute(
                "SELECT * FROM driver_requests WHERE request_id = ? FOR UPDATE",
                [requestId]
            );

            if (!requests.length) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: "Driver request not found." });
            }

            const reqData = requests[0];

            if (status === "Approved") {
                const [existing] = await connection.execute(
                    "SELECT driver_id FROM drivers WHERE phone_no = ? OR email = ? OR license_no = ? LIMIT 1",
                    [reqData.phone_no, reqData.email, reqData.license_no]
                );

                const finalExp = (experience !== undefined && experience !== "" && !isNaN(Number(experience)))
                    ? Number(experience)
                    : (reqData.experience !== undefined ? Number(reqData.experience) : 5);
                const finalSalary = salary ? Number(salary) : 18000;

                if (existing.length) {
                    await connection.execute(
                        `UPDATE drivers
                         SET status = 'Active',
                             salary = COALESCE(?, salary),
                             experience = COALESCE(?, experience),
                             license_photo = COALESCE(?, license_photo)
                         WHERE driver_id = ?`,
                        [finalSalary, finalExp, reqData.license_photo || null, existing[0].driver_id]
                    );
                } else {
                    const defaultHash = await bcrypt.hash("Driver@123", 10);
                    await connection.execute(
                        `INSERT INTO drivers
                            (name, phone_no, email, license_no, password, salary, experience, license_photo, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
                        [
                            reqData.name,
                            reqData.phone_no,
                            reqData.email,
                            reqData.license_no,
                            defaultHash,
                            finalSalary,
                            finalExp,
                            reqData.license_photo || null
                        ]
                    );
                }
            }

            if (status === "Approved") {
                await connection.execute(
                    "UPDATE driver_requests SET status = ?, reviewed_at = NOW(), experience = ? WHERE request_id = ?",
                    [status, finalExp, requestId]
                );
            } else {
                await connection.execute(
                    "UPDATE driver_requests SET status = ?, reviewed_at = NOW() WHERE request_id = ?",
                    [status, requestId]
                );
            }

            await connection.commit();
            await broadcastStatistics();
            io.emit("driverRequestsUpdated");
            io.emit("driversUpdated");

            res.json({
                success: true,
                message: `Driver request has been ${status.toLowerCase()} successfully.`
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Driver request status update error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.delete("/driver-requests/:id", async (req, res) => {
        try {
            const requestId = Number(req.params.id);
            await db.execute("DELETE FROM driver_requests WHERE request_id = ?", [requestId]);
            await broadcastStatistics();
            io.emit("driverRequestsUpdated");
            res.json({ success: true, message: "Driver request deleted successfully." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 3. STUDENTS MANAGEMENT
    // ==========================================
    router.get("/students", async (req, res) => {
        try {
            const search = (req.query.search || "").trim();
            const routeId = req.query.routeId ? Number(req.query.routeId) : null;
            const busId = req.query.busId ? Number(req.query.busId) : null;
            const feeFilter = req.query.feeStatus || "";
            const statusFilter = req.query.status || "";

            let query = `
                SELECT
                    s.student_id,
                    s.name,
                    s.roll_no,
                    s.branch,
                    s.year,
                    s.phone_no,
                    s.email,
                    s.residential_address,
                    s.status,
                    s.created_at,
                    st.transport_id,
                    st.route_id,
                    r.route_name,
                    st.stop_id,
                    sp.stop_name,
                    COALESCE(sp.distance_km, 0) AS distance_km,
                    COALESCE(st.bus_id, b.bus_id) AS bus_id,
                    b.bus_number,
                    b.bus_name,
                    COALESCE(f.amount, 0) AS configured_fee,
                    COALESCE(p.total_paid, 0) AS total_paid,
                    COALESCE(pp.pending_count, 0) AS pending_payments_count
                FROM students s
                LEFT JOIN (
                    SELECT student_id, MAX(transport_id) AS max_tid
                    FROM student_transport
                    WHERE status != 'Inactive' OR status IS NULL
                    GROUP BY student_id
                ) latest_st ON s.student_id = latest_st.student_id
                LEFT JOIN student_transport st ON latest_st.max_tid = st.transport_id
                LEFT JOIN routes r ON st.route_id = r.route_id
                LEFT JOIN stops sp ON st.stop_id = sp.stop_id
                LEFT JOIN buses b ON (st.bus_id = b.bus_id OR (st.bus_id IS NULL AND b.route_id = st.route_id))
                LEFT JOIN fees f ON sp.stop_id = f.stop_id AND f.status = 'Active'
                LEFT JOIN (
                    SELECT student_id, SUM(amount) AS total_paid
                    FROM payments
                    WHERE payment_status = 'Success'
                    GROUP BY student_id
                ) p ON s.student_id = p.student_id
                LEFT JOIN (
                    SELECT student_id, COUNT(*) AS pending_count
                    FROM payments
                    WHERE payment_status = 'Pending'
                    GROUP BY student_id
                ) pp ON s.student_id = pp.student_id
                WHERE 1 = 1
            `;
            const params = [];

            if (search) {
                query += ` AND (s.name LIKE ? OR s.roll_no LIKE ? OR s.phone_no LIKE ? OR s.branch LIKE ? OR s.email LIKE ?)`;
                const term = `%${search}%`;
                params.push(term, term, term, term, term);
            }

            if (routeId) {
                query += ` AND st.route_id = ?`;
                params.push(routeId);
            }

            if (busId) {
                query += ` AND (st.bus_id = ? OR (st.bus_id IS NULL AND b.bus_id = ?))`;
                params.push(busId, busId);
            }

            if (statusFilter) {
                query += ` AND s.status = ?`;
                params.push(statusFilter);
            }

            query += ` ORDER BY s.student_id DESC`;

            const [rows] = await db.query(query, params);

            const students = rows.map(s => {
                const distanceKm = Number(s.distance_km || 0);
                const hasStop = Boolean(s.stop_id);
                const applicableFee = hasStop
                    ? (Number(s.configured_fee) > 0 ? Number(s.configured_fee) : calculateDistanceFee(distanceKm))
                    : 0;
                const totalPaid = Number(s.total_paid || 0);
                const outstanding = Math.max(0, applicableFee - totalPaid);
                const hasPending = Number(s.pending_payments_count) > 0;

                let feeStatus = "Unpaid";
                if (hasPending) {
                    feeStatus = "Pending Verification";
                } else if (totalPaid >= applicableFee && applicableFee > 0) {
                    feeStatus = "Paid";
                } else if (totalPaid > 0 && totalPaid < applicableFee) {
                    feeStatus = "Partially Paid";
                } else if (!hasStop && totalPaid > 0) {
                    feeStatus = "Paid";
                }

                return {
                    id: s.student_id,
                    student_id: s.student_id,
                    name: s.name,
                    roll: s.roll_no,
                    roll_no: s.roll_no,
                    branch: s.branch,
                    year: s.year,
                    phone: s.phone_no,
                    phone_no: s.phone_no,
                    email: s.email,
                    residential_address: s.residential_address,
                    status: s.status,
                    created_at: s.created_at,
                    route_id: s.route_id,
                    route: s.route_name || "Not assigned",
                    route_name: s.route_name || "Not assigned",
                    stop_id: s.stop_id,
                    stop: s.stop_name || "Not assigned",
                    stop_name: s.stop_name || "Not assigned",
                    distance_km: distanceKm,
                    bus_id: s.bus_id,
                    bus_number: s.bus_number || "Not assigned",
                    applicable_fee: applicableFee,
                    total_paid: totalPaid,
                    outstanding_amount: outstanding,
                    fee_status: feeStatus,
                    fee: feeStatus
                };
            });

            // Filter in-memory if fee status filter requested
            const finalStudents = feeFilter && feeFilter !== "All"
                ? students.filter(s => s.fee_status.toLowerCase() === feeFilter.toLowerCase())
                : students;

            res.json({
                success: true,
                total: finalStudents.length,
                students: finalStudents
            });
        } catch (error) {
            console.error("Admin fetch students error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/students/:id", async (req, res) => {
        try {
            const studentId = Number(req.params.id);
            const [students] = await db.query(
                `SELECT s.*, st.route_id, r.route_name, st.stop_id, sp.stop_name, sp.distance_km, COALESCE(st.bus_id, b.bus_id) AS bus_id, b.bus_number
                 FROM students s
                 LEFT JOIN student_transport st ON s.student_id = st.student_id AND (st.status != 'Inactive' OR st.status IS NULL)
                 LEFT JOIN routes r ON st.route_id = r.route_id
                 LEFT JOIN stops sp ON st.stop_id = sp.stop_id
                 LEFT JOIN buses b ON (st.bus_id = b.bus_id OR (st.bus_id IS NULL AND b.route_id = st.route_id))
                 WHERE s.student_id = ?
                 ORDER BY st.transport_id DESC
                 LIMIT 1`,
                [studentId]
            );

            if (!students.length) {
                return res.status(404).json({ success: false, message: "Student not found." });
            }

            const student = students[0];
            delete student.password;

            // Fetch payment history
            const [payments] = await db.query(
                "SELECT payment_id, amount, transaction_id, payment_status, payment_date, payment_method FROM payments WHERE student_id = ? ORDER BY payment_id DESC",
                [studentId]
            );

            // Fetch bus passes
            const [passes] = await db.query(
                "SELECT pass_id, pass_number, status, issue_date, valid_to FROM bus_passes WHERE student_id = ? ORDER BY pass_id DESC",
                [studentId]
            );

            const applicableFee = calculateDistanceFee(student.distance_km);
            const totalPaid = payments
                .filter(p => p.payment_status === "Success")
                .reduce((sum, p) => sum + Number(p.amount || 0), 0);

            res.json({
                success: true,
                student: {
                    ...student,
                    applicable_fee: applicableFee,
                    total_paid: totalPaid,
                    outstanding_amount: Math.max(0, applicableFee - totalPaid),
                    payments,
                    passes
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/students", async (req, res) => {
        let connection;
        try {
            const { name, roll_no, branch, year, phone_no, email, residential_address, route_id, stop_id, bus_id } = req.body;
            if (!name || !roll_no) {
                return res.status(400).json({ success: false, message: "Name and Roll Number are required." });
            }

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [existing] = await connection.execute("SELECT student_id FROM students WHERE roll_no = ?", [roll_no.trim()]);
            if (existing.length) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: "A student with this Roll Number already exists." });
            }

            const bcrypt = require("bcrypt");
            const hashedPassword = await bcrypt.hash(req.body.password || "CampusGo@123", 10);
            const studentPhone = phone_no ? String(phone_no).trim() : `9${Math.floor(100000000 + Math.random()*900000000)}`;
            const studentEmail = email ? String(email).trim() : `${roll_no.trim().toLowerCase()}@vemu.org`;

            const [result] = await connection.execute(
                `INSERT INTO students (name, roll_no, branch, year, phone_no, email, password, residential_address, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                [
                    name.trim(),
                    roll_no.trim(),
                    branch ? branch.trim() : "General",
                    year ? year.trim() : "1st Year",
                    studentPhone,
                    studentEmail,
                    hashedPassword,
                    residential_address ? residential_address.trim() : "Campus Hostels"
                ]
            );

            const newStudentId = result.insertId;

            if (route_id && stop_id) {
                let assignedBusId = bus_id ? Number(bus_id) : null;
                if (!assignedBusId) {
                    const [bRows] = await connection.execute(
                        "SELECT bus_id FROM buses WHERE route_id = ? AND status = 'Active' LIMIT 1",
                        [Number(route_id)]
                    );
                    if (bRows.length > 0) assignedBusId = bRows[0].bus_id;
                }
                await connection.execute(
                    `INSERT INTO student_transport (student_id, route_id, stop_id, bus_id, status)
                     VALUES (?, ?, ?, ?, 'Active')`,
                    [newStudentId, Number(route_id), Number(stop_id), assignedBusId]
                );
            }

            await connection.commit();
            await broadcastStatistics();
            io.emit("studentsUpdated");

            res.status(201).json({ success: true, message: "Student created successfully.", student_id: newStudentId });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Create student error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.delete("/students/:id", async (req, res) => {
        let connection;
        try {
            const studentId = Number(req.params.id);
            connection = await db.getConnection();
            await connection.beginTransaction();

            await connection.execute("UPDATE bus_pass_requests SET payment_id = NULL WHERE student_id = ?", [studentId]).catch(() => {});
            await connection.execute("DELETE FROM transport_cancellations WHERE student_id = ?", [studentId]).catch(() => {});
            await connection.execute("DELETE FROM bus_passes WHERE student_id = ?", [studentId]).catch(() => {});
            await connection.execute("DELETE FROM bus_pass_requests WHERE student_id = ?", [studentId]).catch(() => {});
            await connection.execute("DELETE FROM payments WHERE student_id = ?", [studentId]).catch(() => {});
            await connection.execute("DELETE FROM student_transport WHERE student_id = ?", [studentId]).catch(() => {});
            await connection.execute("DELETE FROM students WHERE student_id = ?", [studentId]);

            await connection.commit();
            await broadcastStatistics();
            io.emit("studentsUpdated");
            res.json({ success: true, message: "Student record permanently deleted.", studentId });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Delete student error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // ==========================================
    // 4. DRIVERS MANAGEMENT
    // ==========================================
    router.get("/drivers", async (req, res) => {
        try {
            const [drivers] = await db.query(`
                SELECT
                    d.driver_id AS id,
                    d.driver_id,
                    d.name,
                    d.phone_no AS phone,
                    d.email,
                    d.license_no AS licence,
                    d.salary,
                    d.experience,
                    d.status,
                    ba.assignment_id,
                    ba.bus_id,
                    b.bus_number,
                    b.bus_name,
                    b.status AS bus_status,
                    t.trip_id,
                    t.route_id,
                    COALESCE(r_trip.route_name, r_bus.route_name) AS route_name,
                    COALESCE(t.status, 'Idle') AS trip_status
                FROM drivers d
                LEFT JOIN (
                    SELECT driver_id, MAX(assignment_id) as max_aid
                    FROM bus_assignments
                    WHERE status = 'Active'
                    GROUP BY driver_id
                ) latest_ba ON d.driver_id = latest_ba.driver_id
                LEFT JOIN bus_assignments ba ON latest_ba.max_aid = ba.assignment_id
                LEFT JOIN buses b ON ba.bus_id = b.bus_id
                LEFT JOIN routes r_bus ON b.route_id = r_bus.route_id
                LEFT JOIN (
                    SELECT driver_id, MAX(trip_id) as max_tid
                    FROM trips
                    WHERE status = 'Started'
                    GROUP BY driver_id
                ) latest_trip ON d.driver_id = latest_trip.driver_id
                LEFT JOIN trips t ON latest_trip.max_tid = t.trip_id
                LEFT JOIN routes r_trip ON t.route_id = r_trip.route_id
                ORDER BY d.driver_id DESC
            `);

            res.json({
                success: true,
                total: drivers.length,
                drivers: drivers.map(d => ({
                    id: d.driver_id,
                    driver_id: d.driver_id,
                    name: d.name,
                    phone: d.phone,
                    email: d.email,
                    licence: d.licence,
                    salary: Number(d.salary || 0),
                    experience: Number(d.experience || 0),
                    status: d.status,
                    bus: d.bus_number || "Not assigned",
                    bus_id: d.bus_id,
                    bus_number: d.bus_number,
                    bus_name: d.bus_name,
                    bus_status: d.bus_status || "N/A",
                    route: d.bus_number
                        ? (d.route_name || "No route assigned")
                        : "Not assigned",
                    route_name: d.route_name,
                    trip_status: d.trip_status
                }))
            });
        } catch (error) {
            console.error("Admin drivers error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/drivers", (handleLicenseUpload || ((req, res, next) => next())), async (req, res) => {
        let connection;
        try {
            const { name, phone_no, phone, email, license_no, licence, salary, experience, bus_id, password } = req.body;
            const driverName = name?.trim();
            const driverPhone = (phone_no || phone)?.trim();
            if (!driverName || !driverPhone) {
                return res.status(400).json({ success: false, message: "Driver name and phone number are required." });
            }

            const driverEmail = email ? email.trim() : `${driverPhone}@driver.campusgo.com`;
            const driverLicence = (license_no || licence) ? (license_no || licence).trim() : `AP03 ${Math.floor(1000 + Math.random()*9000)}`;
            const driverExp = (experience !== undefined && experience !== "" && !isNaN(Number(experience))) ? Number(experience) : 0;
            const driverSalary = (salary !== undefined && salary !== "" && !isNaN(Number(salary))) ? Number(salary) : 22000;
            const licensePhotoPath = req.file ? ("/uploads/licenses/" + req.file.filename) : (req.body.license_photo || null);

            const bcrypt = require("bcrypt");
            const hashedPassword = await bcrypt.hash(password || "Driver@123", 10);

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [existing] = await connection.execute(
                "SELECT driver_id FROM drivers WHERE phone_no = ? OR email = ? OR license_no = ? LIMIT 1",
                [driverPhone, driverEmail, driverLicence]
            );
            if (existing.length > 0) {
                await connection.rollback();
                return res.status(409).json({ success: false, message: "Phone number, email, or licence number is already registered." });
            }

            const [result] = await connection.execute(
                `INSERT INTO drivers (name, phone_no, email, license_no, password, salary, experience, license_photo, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
                [
                    driverName,
                    driverPhone,
                    driverEmail,
                    driverLicence,
                    hashedPassword,
                    driverSalary,
                    driverExp,
                    licensePhotoPath
                ]
            );

            const newDriverId = result.insertId;

            // Also keep driver_requests in sync marked as Approved
            await connection.execute(
                `INSERT INTO driver_requests (name, phone_no, email, license_no, experience, password, license_photo, status, reviewed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'Approved', NOW())
                 ON DUPLICATE KEY UPDATE status = 'Approved', reviewed_at = NOW()`,
                [
                    driverName,
                    driverPhone,
                    driverEmail,
                    driverLicence,
                    driverExp,
                    hashedPassword,
                    licensePhotoPath
                ]
            ).catch(() => {});

            if (bus_id && Number(bus_id) > 0) {
                await connection.execute("UPDATE bus_assignments SET status = 'Inactive' WHERE bus_id = ?", [Number(bus_id)]);
                await connection.execute(
                    `INSERT INTO bus_assignments (bus_id, driver_id, academic_year, status)
                     VALUES (?, ?, '2026-27', 'Active')`,
                    [Number(bus_id), newDriverId]
                );
            }

            await connection.commit();
            await broadcastStatistics();
            io.emit("driversUpdated");
            io.emit("busesUpdated");
            io.emit("driverRequestsUpdated");

            res.status(201).json({ success: true, message: "Driver registered successfully.", driver_id: newDriverId });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Create driver error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.put("/drivers/:id", async (req, res) => {
        try {
            const driverId = Number(req.params.id);
            const { name, phone, email, licence, salary, experience, status } = req.body;

            const [driver] = await db.query("SELECT driver_id FROM drivers WHERE driver_id = ?", [driverId]);
            if (!driver.length) {
                return res.status(404).json({ success: false, message: "Driver not found." });
            }

            await db.execute(
                `UPDATE drivers
                 SET name = COALESCE(?, name),
                     phone_no = COALESCE(?, phone_no),
                     email = COALESCE(?, email),
                     license_no = COALESCE(?, license_no),
                     salary = COALESCE(?, salary),
                     experience = COALESCE(?, experience),
                     status = COALESCE(?, status)
                 WHERE driver_id = ?`,
                [
                    name !== undefined ? name : null,
                    phone !== undefined ? phone : null,
                    email !== undefined ? email : null,
                    licence !== undefined ? licence : null,
                    salary !== undefined ? salary : null,
                    experience !== undefined ? experience : null,
                    status !== undefined ? status : null,
                    driverId
                ]
            );

            await broadcastStatistics();
            io.emit("driversUpdated");

            res.json({ success: true, message: "Driver updated successfully." });
        } catch (error) {
            console.error("Update driver error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/drivers/:id/assign-bus", async (req, res) => {
        let connection;
        try {
            const driverId = Number(req.params.id);
            const { bus_id } = req.body;
            const busId = Number(bus_id);

            connection = await db.getConnection();
            await connection.beginTransaction();

            // Deactivate previous assignments for this driver and this bus
            await connection.execute(
                "UPDATE bus_assignments SET status = 'Inactive' WHERE driver_id = ? OR bus_id = ?",
                [driverId, busId]
            );

            if (busId > 0) {
                await connection.execute(
                    "INSERT INTO bus_assignments (bus_id, driver_id, assignment_date, status) VALUES (?, ?, CURDATE(), 'Active')",
                    [busId, driverId]
                );
            }

            await connection.commit();
            await broadcastStatistics();
            io.emit("driversUpdated");
            io.emit("busesUpdated");

            res.json({ success: true, message: "Bus assigned to driver successfully." });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.delete("/drivers/:id", async (req, res) => {
        let connection;
        try {
            const driverId = Number(req.params.id);
            connection = await db.getConnection();
            await connection.beginTransaction();

            // 1. Find all trips associated with this driver to clean their foreign-key dependencies
            const [driverTrips] = await connection.query(
                "SELECT trip_id FROM trips WHERE driver_id = ?",
                [driverId]
            );
            const tripIds = driverTrips.map(t => t.trip_id);

            if (tripIds.length > 0) {
                // Delete live_locations and trip_stop_progress belonging to these trips
                await connection.query(
                    `DELETE FROM live_locations WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`,
                    tripIds
                ).catch(() => {});

                await connection.query(
                    `DELETE FROM trip_stop_progress WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`,
                    tripIds
                ).catch(() => {});

                // Delete the trips themselves
                await connection.query(
                    `DELETE FROM trips WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`,
                    tripIds
                );
            }

            // 2. Delete diesel records referencing this driver
            await connection.execute(
                "DELETE FROM diesel_records WHERE driver_id = ?",
                [driverId]
            ).catch(() => {});

            // 3. Delete bus assignments for this driver
            await connection.execute(
                "DELETE FROM bus_assignments WHERE driver_id = ?",
                [driverId]
            ).catch(() => {});

            // 4. Delete driver requests for this driver
            await connection.execute(
                "DELETE FROM driver_requests WHERE driver_id = ?",
                [driverId]
            ).catch(() => {});

            // 5. Delete driver locations
            await connection.execute(
                "DELETE FROM driver_locations WHERE driver_id = ?",
                [driverId]
            ).catch(() => {});

            // 6. Delete driver record
            await connection.execute(
                "DELETE FROM drivers WHERE driver_id = ?",
                [driverId]
            );

            await connection.commit();
            await broadcastStatistics();
            io.emit("driversUpdated");
            io.emit("busesUpdated");
            res.json({ success: true, message: "Driver permanently deleted from database." });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Delete driver error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // ==========================================
    // 5. BUSES MANAGEMENT
    // ==========================================
    router.get("/buses", async (req, res) => {
        try {
            const [buses] = await db.query(`
                SELECT
                    b.bus_id AS id,
                    b.bus_id,
                    b.bus_number,
                    b.bus_name,
                    b.capacity,
                    b.status,
                    ba.driver_id,
                    d.name AS driver_name,
                    d.phone_no AS driver_phone,
                    t.trip_id,
                    t.route_id,
                    r.route_name,
                    COALESCE(t.status, 'Idle') AS trip_status
                FROM buses b
                LEFT JOIN (
                    SELECT bus_id, MAX(assignment_id) as max_aid
                    FROM bus_assignments
                    WHERE status = 'Active'
                    GROUP BY bus_id
                ) latest_ba ON b.bus_id = latest_ba.bus_id
                LEFT JOIN bus_assignments ba ON latest_ba.max_aid = ba.assignment_id
                LEFT JOIN drivers d ON ba.driver_id = d.driver_id
                LEFT JOIN (
                    SELECT bus_id, MAX(trip_id) as max_tid
                    FROM trips
                    WHERE status = 'Started'
                    GROUP BY bus_id
                ) latest_trip ON b.bus_id = latest_trip.bus_id
                LEFT JOIN trips t ON latest_trip.max_tid = t.trip_id
                LEFT JOIN routes r ON t.route_id = r.route_id
                ORDER BY b.bus_id DESC
            `);

            res.json({
                success: true,
                total: buses.length,
                buses: buses.map(b => {
                    const isWorking = ["Active", "Available"].includes(b.status);
                    return {
                        id: b.bus_id,
                        bus_id: b.bus_id,
                        number: b.bus_number,
                        bus_number: b.bus_number,
                        name: b.bus_name,
                        bus_name: b.bus_name,
                        capacity: b.capacity,
                        status: b.status,
                        condition: isWorking ? "Working" : "Not working",
                        driver: b.driver_name || "Not assigned",
                        driver_id: b.driver_id,
                        driver_name: b.driver_name,
                        driver_phone: b.driver_phone,
                        route: b.route_name || "Not assigned",
                        route_id: b.route_id,
                        route_name: b.route_name,
                        trip_status: b.trip_status
                    };
                })
            });
        } catch (error) {
            console.error("Admin fetch buses error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/buses", async (req, res) => {
        try {
            const { bus_number, bus_name, capacity, status } = req.body;
            if (!bus_number || !capacity) {
                return res.status(400).json({ success: false, message: "Bus number and capacity are required." });
            }

            const [existing] = await db.query("SELECT bus_id FROM buses WHERE bus_number = ? LIMIT 1", [bus_number]);
            if (existing.length) {
                return res.status(409).json({ success: false, message: "A bus with this number already exists." });
            }

            const [result] = await db.execute(
                "INSERT INTO buses (bus_number, bus_name, capacity, status) VALUES (?, ?, ?, ?)",
                [bus_number.trim(), (bus_name || "").trim(), Number(capacity), status || "Active"]
            );

            await broadcastStatistics();
            io.emit("busesUpdated");

            res.status(201).json({ success: true, message: "Bus added successfully.", bus_id: result.insertId });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.put("/buses/:id", async (req, res) => {
        try {
            const busId = Number(req.params.id);
            const { bus_number, bus_name, capacity, status } = req.body;

            await db.execute(
                `UPDATE buses
                 SET bus_number = COALESCE(?, bus_number),
                     bus_name = COALESCE(?, bus_name),
                     capacity = COALESCE(?, capacity),
                     status = COALESCE(?, status)
                 WHERE bus_id = ?`,
                [bus_number, bus_name, capacity ? Number(capacity) : null, status, busId]
            );

            await broadcastStatistics();
            io.emit("busesUpdated");

            res.json({ success: true, message: "Bus updated successfully." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.patch("/buses/:id/status", async (req, res) => {
        try {
            const busId = Number(req.params.id);
            const { status } = req.body;
            if (!status) {
                return res.status(400).json({ success: false, message: "Status is required." });
            }

            await db.execute("UPDATE buses SET status = ? WHERE bus_id = ?", [status, busId]);

            await broadcastStatistics();
            io.emit("busesUpdated");

            res.json({ success: true, message: "Bus status updated successfully." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/buses/:id/assign", async (req, res) => {
        let connection;
        try {
            const busId = Number(req.params.id);
            const { driver_id, route_id } = req.body;

            connection = await db.getConnection();
            await connection.beginTransaction();

            if (driver_id !== undefined && driver_id !== null) {
                const driverId = Number(driver_id);
                // Deactivate previous active assignment for this bus
                await connection.execute(
                    "UPDATE bus_assignments SET status = 'Inactive' WHERE bus_id = ?",
                    [busId]
                );

                if (driverId > 0) {
                    // Also deactivate any assignment this driver currently holds
                    await connection.execute(
                        "UPDATE bus_assignments SET status = 'Inactive' WHERE driver_id = ?",
                        [driverId]
                    );

                    await connection.execute(
                        "INSERT INTO bus_assignments (bus_id, driver_id, assignment_date, status) VALUES (?, ?, CURDATE(), 'Active')",
                        [busId, driverId]
                    );
                }
            }

            await connection.commit();
            await broadcastStatistics();
            io.emit("busesUpdated");
            io.emit("driversUpdated");

            res.json({ success: true, message: "Bus assignment updated successfully." });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.delete("/buses/:id", async (req, res) => {
        let connection;
        try {
            const busId = Number(req.params.id);
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [busRows] = await connection.execute("SELECT bus_number FROM buses WHERE bus_id = ?", [busId]);
            const busNumber = busRows[0]?.bus_number;

            // 1. Find all trips associated with this bus
            const [busTrips] = await connection.query(
                "SELECT trip_id FROM trips WHERE bus_id = ?",
                [busId]
            );
            const tripIds = busTrips.map(t => t.trip_id);

            if (tripIds.length > 0) {
                await connection.query(
                    `DELETE FROM live_locations WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`,
                    tripIds
                ).catch(() => {});

                await connection.query(
                    `DELETE FROM trip_stop_progress WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`,
                    tripIds
                ).catch(() => {});

                await connection.query(
                    `DELETE FROM trips WHERE trip_id IN (${tripIds.map(() => '?').join(',')})`,
                    tripIds
                );
            }

            // 2. Delete live locations and bus locations linked to bus
            await connection.execute("DELETE FROM live_locations WHERE bus_id = ?", [busId]).catch(() => {});
            await connection.execute("DELETE FROM bus_locations WHERE bus_id = ?", [busId]).catch(() => {});

            // 3. Delete diesel records for this bus
            await connection.execute("DELETE FROM diesel_records WHERE bus_id = ?", [busId]).catch(() => {});

            // 4. Unlink foreign keys in payments, bus_pass_requests, student_transport
            await connection.execute("UPDATE payments SET bus_id = NULL WHERE bus_id = ?", [busId]).catch(() => {});
            await connection.execute("UPDATE bus_pass_requests SET bus_id = NULL WHERE bus_id = ?", [busId]).catch(() => {});
            await connection.execute("UPDATE student_transport SET bus_id = NULL WHERE bus_id = ?", [busId]).catch(() => {});

            if (busNumber) {
                await connection.execute("UPDATE bus_passes SET bus_number = 'Unassigned' WHERE bus_number = ?", [busNumber]).catch(() => {});
            }

            // 5. Delete bus assignments
            await connection.execute("DELETE FROM bus_assignments WHERE bus_id = ?", [busId]).catch(() => {});

            // 6. Delete bus
            await connection.execute("DELETE FROM buses WHERE bus_id = ?", [busId]);

            await connection.commit();
            await broadcastStatistics();
            io.emit("busesUpdated");
            io.emit("driversUpdated");
            res.json({ success: true, message: "Bus permanently deleted from database." });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Delete bus error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // ==========================================
    // 6. ROUTES AND STOPS MANAGEMENT
    // ==========================================
    router.get("/routes", async (req, res) => {
        try {
            const [routes] = await db.query(`
                SELECT
                    r.route_id AS id,
                    r.route_id,
                    r.route_name AS name,
                    r.route_name,
                    r.start_location,
                    r.end_location,
                    r.status,
                    COUNT(DISTINCT rs.stop_id) AS stops_count,
                    COUNT(DISTINCT st.student_id) AS students_count,
                    GROUP_CONCAT(DISTINCT b.bus_number SEPARATOR ', ') AS assigned_buses
                FROM routes r
                LEFT JOIN route_stops rs ON r.route_id = rs.route_id
                LEFT JOIN student_transport st ON r.route_id = st.route_id
                    AND (st.status = 'Active' OR EXISTS (SELECT 1 FROM bus_passes bp WHERE bp.student_id = st.student_id AND bp.status = 'Active'))
                LEFT JOIN buses b ON r.route_id = b.route_id
                LEFT JOIN trips t ON r.route_id = t.route_id AND t.status = 'Started'
                LEFT JOIN buses tb ON t.bus_id = tb.bus_id
                WHERE r.status <> 'Deleted'
                GROUP BY r.route_id
                ORDER BY r.route_name
            `);

            res.json({
                success: true,
                total: routes.length,
                routes: routes.map(r => ({
                    id: r.route_id,
                    route_id: r.route_id,
                    name: r.route_name,
                    route_name: r.route_name,
                    start_location: r.start_location,
                    end_location: r.end_location,
                    status: r.status,
                    stops_count: Number(r.stops_count || 0),
                    students_count: Number(r.students_count || 0),
                    assigned_buses: r.assigned_buses || "None"
                }))
            });
        } catch (error) {
            console.error("Admin routes error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/routes/:id", async (req, res) => {
        try {
            const routeId = Number(req.params.id);
            const [routeRows] = await db.query(
                "SELECT route_id, route_name, start_location, end_location, status FROM routes WHERE route_id = ?",
                [routeId]
            );
            if (!routeRows.length) {
                return res.status(404).json({ success: false, message: "Route not found." });
            }

            const [stops] = await db.query(`
                SELECT
                    s.stop_id,
                    s.stop_name,
                    s.location,
                    COALESCE(s.distance_km, 0) AS distance_km,
                    rs.stop_order,
                    COALESCE(f.amount, 0) AS configured_fee,
                    COALESCE(st.student_count, 0) AS student_count
                FROM route_stops rs
                JOIN stops s ON rs.stop_id = s.stop_id
                LEFT JOIN (
                    SELECT stop_id, MAX(amount) AS amount
                    FROM fees
                    WHERE status = 'Active'
                    GROUP BY stop_id
                ) f ON s.stop_id = f.stop_id
                LEFT JOIN (
                    SELECT stop_id, COUNT(DISTINCT student_id) AS student_count
                    FROM student_transport
                    WHERE (status = 'Active' OR EXISTS (SELECT 1 FROM bus_passes bp WHERE bp.student_id = student_transport.student_id AND bp.status = 'Active'))
                    GROUP BY stop_id
                ) st ON s.stop_id = st.stop_id
                WHERE rs.route_id = ?
                ORDER BY rs.stop_order ASC
            `, [routeId]);

            res.json({
                success: true,
                route: routeRows[0],
                stops: stops.map(s => {
                    const dist = Number(s.distance_km || 0);
                    const fee = Number(s.configured_fee) > 0 ? Number(s.configured_fee) : calculateDistanceFee(dist);
                    return {
                        ...s,
                        distance_km: dist,
                        applicable_fee: fee,
                        student_count: Number(s.student_count || 0)
                    };
                })
            });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/routes", async (req, res) => {
        try {
            const { route_name, start_location, end_location, status } = req.body;
            if (!route_name || !start_location || !end_location) {
                return res.status(400).json({ success: false, message: "Route name, start and end locations are required." });
            }

            const [result] = await db.execute(
                "INSERT INTO routes (route_name, start_location, end_location, status) VALUES (?, ?, ?, ?)",
                [route_name.trim(), start_location.trim(), end_location.trim(), status || "Active"]
            );

            await broadcastStatistics();
            io.emit("routesUpdated");

            res.status(201).json({ success: true, message: "Route created successfully.", route_id: result.insertId });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.put("/routes/:id", async (req, res) => {
        try {
            const routeId = Number(req.params.id);
            const { route_name, start_location, end_location, status } = req.body;

            await db.execute(
                `UPDATE routes
                 SET route_name = COALESCE(?, route_name),
                     start_location = COALESCE(?, start_location),
                     end_location = COALESCE(?, end_location),
                     status = COALESCE(?, status)
                 WHERE route_id = ?`,
                [
                    route_name !== undefined ? route_name : null,
                    start_location !== undefined ? start_location : null,
                    end_location !== undefined ? end_location : null,
                    status !== undefined ? status : null,
                    routeId
                ]
            );

            io.emit("routesUpdated");
            res.json({ success: true, message: "Route updated successfully." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/all-stops", async (req, res) => {
        try {
            const [stops] = await db.query(`
                SELECT
                    s.stop_id,
                    s.stop_name,
                    s.location,
                    COALESCE(s.distance_km, 0) AS distance_km,
                    COALESCE(f.amount, 0) AS fee_amount
                FROM stops s
                LEFT JOIN fees f ON s.stop_id = f.stop_id AND f.status = 'Active'
                WHERE s.status = 'Active'
                ORDER BY s.stop_name ASC
            `);
            res.json({ success: true, stops });
        } catch (error) {
            console.error("Get all stops error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/routes/:id/stops", async (req, res) => {
        let connection;
        try {
            const routeId = Number(req.params.id);
            const { stop_id, stop_order, stop_name, location, distance_km, fee_amount } = req.body;

            let finalStopId = Number(stop_id);

            connection = await db.getConnection();
            await connection.beginTransaction();

            // If a new stop name is provided, create the new stop in the database first
            if (stop_name && String(stop_name).trim()) {
                const sName = String(stop_name).trim();
                const loc = String(location || "").trim();
                const dist = distance_km !== undefined && distance_km !== "" ? Number(distance_km) : 0;

                const [stopResult] = await connection.execute(
                    "INSERT INTO stops (stop_name, location, distance_km, status) VALUES (?, ?, ?, 'Active')",
                    [sName, loc, dist]
                );
                finalStopId = stopResult.insertId;

                const fee = fee_amount !== undefined && fee_amount !== "" ? Number(fee_amount) : calculateDistanceFee(dist);
                if (fee > 0) {
                    await connection.execute(
                        "INSERT INTO fees (stop_id, amount, academic_year, status) VALUES (?, ?, '2026-27', 'Active')",
                        [finalStopId, fee]
                    );
                }
            }

            if (!finalStopId || finalStopId <= 0) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: "Please select an existing stop or enter a stop name." });
            }

            // Determine sequence order if not specified
            let order = Number(stop_order);
            if (!order || order <= 0) {
                const [existingOrders] = await connection.execute(
                    "SELECT COALESCE(MAX(stop_order), 0) + 1 AS next_order FROM route_stops WHERE route_id = ?",
                    [routeId]
                );
                order = existingOrders[0].next_order;
            }

            // Check if stop is already in this route
            const [existing] = await connection.execute(
                "SELECT route_stop_id FROM route_stops WHERE route_id = ? AND stop_id = ? LIMIT 1",
                [routeId, finalStopId]
            );

            if (existing.length) {
                await connection.execute(
                    "UPDATE route_stops SET stop_order = ? WHERE route_id = ? AND stop_id = ?",
                    [order, routeId, finalStopId]
                );
            } else {
                await connection.execute(
                    "INSERT INTO route_stops (route_id, stop_id, stop_order) VALUES (?, ?, ?)",
                    [routeId, finalStopId, order]
                );
            }

            await connection.commit();
            io.emit("routesUpdated");
            io.emit("feesUpdated");

            res.status(201).json({
                success: true,
                message: "Stop assigned to route successfully!",
                stop_id: finalStopId,
                stop_order: order
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Add stop to route error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.put("/stops/:id", async (req, res) => {
        try {
            const stopId = Number(req.params.id);
            const { stop_name, location, distance_km, fee_amount } = req.body;

            await db.execute(
                `UPDATE stops
                 SET stop_name = COALESCE(?, stop_name),
                     location = COALESCE(?, location),
                     distance_km = COALESCE(?, distance_km)
                 WHERE stop_id = ?`,
                [
                    stop_name !== undefined ? stop_name : null,
                    location !== undefined ? location : null,
                    distance_km !== undefined && distance_km !== "" ? Number(distance_km) : null,
                    stopId
                ]
            );

            if (fee_amount !== undefined && fee_amount !== null && fee_amount !== "") {
                const amount = Number(fee_amount);
                const [existingFee] = await db.query("SELECT fee_id FROM fees WHERE stop_id = ? AND status = 'Active' LIMIT 1", [stopId]);
                if (existingFee.length) {
                    await db.execute("UPDATE fees SET amount = ? WHERE fee_id = ?", [amount, existingFee[0].fee_id]);
                } else {
                    await db.execute("INSERT INTO fees (stop_id, amount, academic_year, status) VALUES (?, ?, '2026-27', 'Active')", [stopId, amount]);
                }
            }

            io.emit("routesUpdated");
            io.emit("feesUpdated");

            res.json({ success: true, message: "Stop and fee updated successfully." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.delete("/routes/:id", async (req, res) => {
        let connection;
        try {
            const routeId = Number(req.params.id);

            // Step 1: check route exists
            const [routeCheck] = await db.query("SELECT route_id, route_name, status FROM routes WHERE route_id = ? LIMIT 1", [routeId]);
            if (!routeCheck.length) {
                return res.status(404).json({ success: false, message: "Route not found." });
            }
            if (routeCheck[0].status === "Deleted") {
                return res.status(400).json({ success: false, message: "Route is already deleted." });
            }

            // Step 2: count dependents across ALL FK tables (excluding route_stops which are safe to remove)
            const [[{ cnt_students }]] = await db.query("SELECT COUNT(*) AS cnt_students FROM student_transport WHERE route_id = ?", [routeId]);
            const [[{ cnt_buses }]]    = await db.query("SELECT COUNT(*) AS cnt_buses FROM buses WHERE route_id = ?", [routeId]);
            const [[{ cnt_bpr }]]      = await db.query("SELECT COUNT(*) AS cnt_bpr FROM bus_pass_requests WHERE route_id = ?", [routeId]);
            const [[{ cnt_pay }]]      = await db.query("SELECT COUNT(*) AS cnt_pay FROM payments WHERE route_id = ?", [routeId]);
            const [[{ cnt_trips }]]    = await db.query("SELECT COUNT(*) AS cnt_trips FROM trips WHERE route_id = ?", [routeId]);

            const hasDependents = (cnt_students + cnt_buses + cnt_bpr + cnt_pay + cnt_trips) > 0;

            connection = await db.getConnection();
            await connection.beginTransaction();

            let mode;
            if (hasDependents) {
                // Soft-delete: set status = 'Deleted', keep all rows and FKs intact
                await connection.execute("UPDATE routes SET status = 'Deleted' WHERE route_id = ?", [routeId]);
                mode = "archived";
            } else {
                // No dependents: safe to hard-delete (only route_stops remain, which we remove first)
                await connection.execute("DELETE FROM route_stops WHERE route_id = ?", [routeId]);
                await connection.execute("DELETE FROM routes WHERE route_id = ?", [routeId]);
                mode = "deleted";
            }

            await connection.commit();
            await broadcastStatistics();
            io.emit("routesUpdated");

            const msg = mode === "deleted"
                ? "Route deleted successfully."
                : `Route archived (${cnt_students} student(s), ${cnt_buses} bus(es), ${cnt_bpr} pass request(s) linked). It will no longer appear in active lists.`;

            res.json({ success: true, message: msg, mode });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Delete route error:", error);
            res.status(500).json({ success: false, message: "Failed to delete route. Please try again." });
        } finally {
            if (connection) connection.release();
        }
    });

    router.delete("/routes/:routeId/stops/:stopId", async (req, res) => {
        try {
            const routeId = Number(req.params.routeId);
            const stopId = Number(req.params.stopId);
            await db.execute("DELETE FROM route_stops WHERE route_id = ? AND stop_id = ?", [routeId, stopId]);
            io.emit("routesUpdated");
            res.json({ success: true, message: "Stop removed from route successfully." });
        } catch (error) {
            console.error("Remove stop from route error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 7. DISTANCE-BASED FEE ASSIGNMENTS
    // ==========================================
    router.get("/fee-rules", (req, res) => {
        res.json({
            success: true,
            slabs: FEE_SLABS,
            description: "College distance-based transport fee slabs (VEMU IT)."
        });
    });

    router.get("/fee-assignments", async (req, res) => {
        try {
            const [rows] = await db.query(`
                SELECT
                    s.student_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.year,
                    s.phone_no,
                    st.route_id,
                    r.route_name,
                    st.stop_id,
                    sp.stop_name,
                    COALESCE(sp.distance_km, 0) AS distance_km,
                    COALESCE(f.amount, 0) AS configured_fee,
                    COALESCE(p.total_paid, 0) AS total_paid,
                    COALESCE(pp.pending_count, 0) AS pending_payments_count
                FROM students s
                INNER JOIN (
                    SELECT student_id, MAX(transport_id) AS max_tid
                    FROM student_transport
                    WHERE status != 'Inactive' OR status IS NULL
                    GROUP BY student_id
                ) latest_st ON s.student_id = latest_st.student_id
                INNER JOIN student_transport st ON latest_st.max_tid = st.transport_id
                LEFT JOIN routes r ON st.route_id = r.route_id
                LEFT JOIN stops sp ON st.stop_id = sp.stop_id
                LEFT JOIN fees f ON sp.stop_id = f.stop_id AND f.status = 'Active'
                LEFT JOIN (
                    SELECT student_id, SUM(amount) AS total_paid
                    FROM payments
                    WHERE payment_status = 'Success'
                    GROUP BY student_id
                ) p ON s.student_id = p.student_id
                LEFT JOIN (
                    SELECT student_id, COUNT(*) AS pending_count
                    FROM payments
                    WHERE payment_status = 'Pending'
                    GROUP BY student_id
                ) pp ON s.student_id = pp.student_id
                ORDER BY s.student_id DESC
            `);

            const feeAssignments = rows.map(item => {
                const dist = Number(item.distance_km || 0);
                const configured = Number(item.configured_fee || 0);
                const fee = configured > 0 ? configured : calculateDistanceFee(dist);
                const paid = Number(item.total_paid || 0);
                const outstanding = Math.max(0, fee - paid);
                const hasPending = Number(item.pending_payments_count) > 0;

                let status = "Unpaid";
                if (hasPending) {
                    status = "Pending Verification";
                } else if (paid >= fee && fee > 0) {
                    status = "Paid";
                } else if (paid > 0 && paid < fee) {
                    status = "Partially Paid";
                }

                return {
                    id: item.student_id,
                    student_id: item.student_id,
                    student_name: item.student_name,
                    roll_no: item.roll_no,
                    branch: item.branch,
                    route_name: item.route_name || "Unassigned",
                    stop_name: item.stop_name || "Unassigned",
                    stop_id: item.stop_id,
                    distance_km: dist,
                    applicable_fee: fee,
                    total_paid: paid,
                    outstanding_amount: outstanding,
                    status,
                    fee_source: configured > 0 ? "Configured Stop Fee" : "Distance Slab Formula"
                };
            });

            res.json({
                success: true,
                total: feeAssignments.length,
                assignments: feeAssignments
            });
        } catch (error) {
            console.error("Admin fee assignments error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.put("/fee-assignments/:stopId", async (req, res) => {
        try {
            const stopId = Number(req.params.stopId);
            const { amount } = req.body;
            const feeAmount = Number(amount);

            if (!Number.isFinite(feeAmount) || feeAmount < 0) {
                return res.status(400).json({ success: false, message: "Please provide a valid fee amount." });
            }

            const [existing] = await db.query(
                "SELECT fee_id FROM fees WHERE stop_id = ? AND status = 'Active' LIMIT 1",
                [stopId]
            );

            if (existing.length) {
                await db.execute(
                    "UPDATE fees SET amount = ? WHERE fee_id = ?",
                    [feeAmount, existing[0].fee_id]
                );
            } else {
                await db.execute(
                    "INSERT INTO fees (stop_id, amount, academic_year, status) VALUES (?, ?, '2026-27', 'Active')",
                    [stopId, feeAmount]
                );
            }

            io.emit("feesUpdated");
            await broadcastStatistics();

            res.json({ success: true, message: "Stop fee updated successfully." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 8. PAYMENTS MANAGEMENT
    // ==========================================
    router.get("/payments", async (req, res) => {
        try {
            const statusFilter = req.query.status || "";

            let query = `
                SELECT
                    p.payment_id AS id,
                    p.payment_id,
                    p.student_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.phone_no,
                    p.fee_id,
                    p.amount,
                    p.transaction_id,
                    p.payment_status,
                    p.payment_method,
                    p.payment_date,
                    p.failure_reason,
                    p.created_at,
                    p.upi_id,
                    r.route_name,
                    sp.stop_name,
                    sp.distance_km,
                    COALESCE(f.amount, p.amount) AS applicable_fee
                FROM payments p
                JOIN students s ON p.student_id = s.student_id
                LEFT JOIN routes r ON p.route_id = r.route_id
                LEFT JOIN stops sp ON p.stop_id = sp.stop_id
                LEFT JOIN fees f ON p.fee_id = f.fee_id
                WHERE 1 = 1
            `;
            const params = [];

            if (statusFilter && statusFilter !== "All") {
                query += ` AND p.payment_status = ?`;
                params.push(statusFilter);
            }

            query += ` ORDER BY p.payment_id DESC`;

            const [rows] = await db.query(query, params);

            res.json({
                success: true,
                total: rows.length,
                payments: rows.map(p => ({
                    id: p.payment_id,
                    payment_id: p.payment_id,
                    student_id: p.student_id,
                    student_name: p.student_name,
                    roll_no: p.roll_no,
                    branch: p.branch,
                    phone: p.phone_no,
                    stop_name: p.stop_name || "N/A",
                    route_name: p.route_name || "N/A",
                    distance_km: Number(p.distance_km || 0),
                    applicable_fee: Number(p.applicable_fee || p.amount),
                    amount: Number(p.amount || 0),
                    amount_paid: Number(p.amount || 0),
                    transaction_id: p.transaction_id || "N/A",
                    transaction_ref: p.transaction_id || "N/A",
                    reference_no: p.transaction_id || "N/A",
                    upi_id: p.upi_id || "N/A",
                    method: p.payment_method || "Online",
                    payment_method: p.payment_method || "Online",
                    payment_mode: p.payment_method || "Online",
                    status: p.payment_status,
                    payment_status: p.payment_status,
                    date: p.payment_date || p.created_at,
                    payment_date: p.payment_date || p.created_at,
                    created_at: p.created_at
                }))
            });
        } catch (error) {
            console.error("Admin payments error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/payments/:id", async (req, res) => {
        try {
            const paymentId = Number(req.params.id);
            const query = `
                SELECT
                    p.payment_id AS id,
                    p.payment_id,
                    p.student_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.phone_no,
                    p.fee_id,
                    p.amount,
                    p.transaction_id,
                    p.payment_status,
                    p.payment_method,
                    p.payment_date,
                    p.failure_reason,
                    p.created_at,
                    p.upi_id,
                    r.route_name,
                    sp.stop_name,
                    sp.distance_km,
                    COALESCE(f.amount, p.amount) AS applicable_fee
                FROM payments p
                JOIN students s ON p.student_id = s.student_id
                LEFT JOIN routes r ON p.route_id = r.route_id
                LEFT JOIN stops sp ON p.stop_id = sp.stop_id
                LEFT JOIN fees f ON p.fee_id = f.fee_id
                WHERE p.payment_id = ?
            `;
            const [rows] = await db.query(query, [paymentId]);
            if (!rows.length) {
                return res.status(404).json({ success: false, message: "Payment record not found." });
            }
            const p = rows[0];
            res.json({
                success: true,
                payment: {
                    id: p.payment_id,
                    payment_id: p.payment_id,
                    student_id: p.student_id,
                    student_name: p.student_name,
                    roll_no: p.roll_no,
                    branch: p.branch,
                    phone: p.phone_no,
                    stop_name: p.stop_name || "N/A",
                    route_name: p.route_name || "N/A",
                    distance_km: Number(p.distance_km || 0),
                    applicable_fee: Number(p.applicable_fee || p.amount),
                    amount: Number(p.amount || 0),
                    amount_paid: Number(p.amount || 0),
                    transaction_id: p.transaction_id || "N/A",
                    transaction_ref: p.transaction_id || "N/A",
                    reference_no: p.transaction_id || "N/A",
                    upi_id: p.upi_id || "N/A",
                    method: p.payment_method || "Online",
                    payment_method: p.payment_method || "Online",
                    payment_mode: p.payment_method || "Online",
                    status: p.payment_status,
                    payment_status: p.payment_status,
                    date: p.payment_date || p.created_at,
                    payment_date: p.payment_date || p.created_at,
                    created_at: p.created_at
                }
            });
        } catch (error) {
            console.error("Admin single payment error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.patch("/payments/:id/verify", async (req, res) => {
        let connection;
        try {
            const paymentId = Number(req.params.id);
            const { status, reason } = req.body;

            if (!["Success", "Failed"].includes(status)) {
                return res.status(400).json({ success: false, message: "Status must be Success or Failed." });
            }

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [payments] = await connection.execute(
                "SELECT payment_id, student_id, payment_status FROM payments WHERE payment_id = ? FOR UPDATE",
                [paymentId]
            );

            if (!payments.length) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: "Payment record not found." });
            }

            await connection.execute(
                "UPDATE payments SET payment_status = ?, failure_reason = ?, payment_date = NOW() WHERE payment_id = ?",
                [status, reason || null, paymentId]
            );

            await connection.commit();
            await broadcastStatistics();
            io.emit("paymentsUpdated");
            io.emit("feesUpdated");

            res.json({
                success: true,
                message: `Payment has been marked as ${status}.`,
                payment_id: paymentId,
                status
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.delete("/payments/:id", async (req, res) => {
        try {
            const paymentId = Number(req.params.id);
            await db.execute("UPDATE bus_pass_requests SET payment_id = NULL WHERE payment_id = ?", [paymentId]).catch(() => {});
            await db.execute("DELETE FROM payments WHERE payment_id = ?", [paymentId]);
            await broadcastStatistics();
            io.emit("paymentsUpdated");
            io.emit("feesUpdated");
            res.json({ success: true, message: "Payment transaction deleted successfully." });
        } catch (error) {
            console.error("Delete payment error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 9. BUS PASS REQUESTS
    // ==========================================
    router.get("/bus-pass-requests", async (req, res) => {
        try {
            const [rows] = await db.query(`
                SELECT
                    bpr.request_id AS id,
                    bpr.request_id,
                    bpr.student_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.phone_no,
                    bpr.route_id,
                    r.route_name,
                    bpr.stop_id,
                    sp.stop_name,
                    COALESCE(sp.distance_km, 0) AS distance_km,
                    bpr.bus_id,
                    b.bus_number,
                    bpr.payment_id,
                    p.payment_status,
                    p.amount AS payment_amount,
                    bpr.status,
                    bpr.admin_remarks,
                    bpr.passport_photo,
                    bpr.requested_at,
                    bpr.reviewed_at,
                    bp.pass_id,
                    bp.pass_number
                FROM bus_pass_requests bpr
                JOIN students s ON bpr.student_id = s.student_id
                LEFT JOIN routes r ON bpr.route_id = r.route_id
                LEFT JOIN stops sp ON bpr.stop_id = sp.stop_id
                LEFT JOIN buses b ON bpr.bus_id = b.bus_id
                LEFT JOIN payments p ON bpr.payment_id = p.payment_id
                LEFT JOIN bus_passes bp ON bpr.request_id = bp.request_id
                ORDER BY
                    CASE WHEN bpr.status = 'Pending' THEN 0 ELSE 1 END,
                    bpr.requested_at DESC
            `);

            res.json({
                success: true,
                total: rows.length,
                requests: rows.map(r => ({
                    id: r.request_id,
                    request_id: r.request_id,
                    student_id: r.student_id,
                    student_name: r.student_name,
                    roll_no: r.roll_no,
                    branch: r.branch,
                    phone: r.phone_no,
                    route: r.route_name || "Not assigned",
                    route_name: r.route_name || "Not assigned",
                    stop: r.stop_name || "Not assigned",
                    stop_name: r.stop_name || "Not assigned",
                    bus: r.bus_number || "Not assigned",
                    bus_number: r.bus_number || "Not assigned",
                    payment_status: r.payment_status || "Unpaid",
                    payment_amount: Number(r.payment_amount || 0),
                    status: r.status,
                    admin_remarks: r.admin_remarks,
                    passport_photo: r.passport_photo || null,
                    date: r.requested_at,
                    requested_at: r.requested_at,
                    pass_id: r.pass_id,
                    pass_number: r.pass_number
                }))
            });
        } catch (error) {
            console.error("Admin bus pass requests error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/bus-pass-requests/:id/approve", async (req, res) => {
        let connection;
        try {
            const requestId = Number(req.params.id);
            const adminId = req.body.admin_id || 1;

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [requests] = await connection.execute(
                `SELECT bpr.*, s.name, s.roll_no, r.route_name, sp.stop_name, b.bus_number, p.amount, p.payment_status
                 FROM bus_pass_requests bpr
                 JOIN students s ON bpr.student_id = s.student_id
                 LEFT JOIN routes r ON bpr.route_id = r.route_id
                 LEFT JOIN stops sp ON bpr.stop_id = sp.stop_id
                 LEFT JOIN buses b ON bpr.bus_id = b.bus_id
                 LEFT JOIN payments p ON bpr.payment_id = p.payment_id
                 WHERE bpr.request_id = ?
                 FOR UPDATE`,
                [requestId]
            );

            if (!requests.length) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: "Bus pass request not found." });
            }

            const reqData = requests[0];

            if (reqData.status === "Approved") {
                await connection.rollback();
                return res.status(400).json({ success: false, message: "Request has already been approved." });
            }

            // Resolve active bus for this route if not directly specified
            let assignedBusId = reqData.bus_id;
            let assignedBusNumber = reqData.bus_number;
            if (!assignedBusId && reqData.route_id) {
                const [busRows] = await connection.execute(
                    "SELECT bus_id, bus_number FROM buses WHERE route_id = ? AND status = 'Active' LIMIT 1",
                    [reqData.route_id]
                );
                if (busRows.length > 0) {
                    assignedBusId = busRows[0].bus_id;
                    assignedBusNumber = busRows[0].bus_number;
                }
            }

            // Check if pass already exists for this request
            const [existingPass] = await connection.execute(
                "SELECT pass_id, pass_number FROM bus_passes WHERE request_id = ? LIMIT 1",
                [requestId]
            );

            let passNumber = "";
            let passId = 0;

            if (existingPass.length) {
                passId = existingPass[0].pass_id;
                passNumber = existingPass[0].pass_number;
                await connection.execute(
                    "UPDATE bus_passes SET bus_id = COALESCE(bus_id, ?), bus_number = COALESCE(NULLIF(bus_number, 'BUS-CAMPUS'), ?) WHERE pass_id = ?",
                    [assignedBusId, assignedBusNumber || "BUS-CAMPUS", passId]
                );
            } else {
                // Generate unique pass number e.g. CG-2026-REQID
                passNumber = `CG-2026-${String(requestId).padStart(6, "0")}`;
                const qrString = `CAMPUSGO:PASS:${passNumber}:STUDENT:${reqData.student_id}:ROLL:${reqData.roll_no}`;
                const amountPaid = reqData.amount ? Number(reqData.amount) : 0;

                const [passResult] = await connection.execute(
                    `INSERT INTO bus_passes
                        (student_id, roll_no, stop_name, route_name, bus_number, amount_paid,
                         pass_number, issue_date, valid_from, valid_to, status, request_id,
                         payment_id, route_id, bus_id, stop_id, qr_data)
                     VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), CURDATE(), DATE_ADD(CURDATE(), INTERVAL 1 YEAR), 'Active', ?, ?, ?, ?, ?, ?)`,
                    [
                        reqData.student_id,
                        reqData.roll_no,
                        reqData.stop_name || "Designated Stop",
                        reqData.route_name || "Campus Route",
                        assignedBusNumber || "BUS-CAMPUS",
                        amountPaid,
                        passNumber,
                        requestId,
                        reqData.payment_id || null,
                        reqData.route_id || null,
                        assignedBusId || null,
                        reqData.stop_id || null,
                        qrString
                    ]
                );
                passId = passResult.insertId;
            }

            // Ensure student_transport record is Active and linked to bus
            const [existingTransport] = await connection.execute(
                "SELECT transport_id FROM student_transport WHERE student_id = ? ORDER BY transport_id DESC LIMIT 1",
                [reqData.student_id]
            );
            if (existingTransport.length > 0) {
                await connection.execute(
                    "UPDATE student_transport SET route_id = ?, stop_id = ?, bus_id = COALESCE(?, bus_id), status = 'Active' WHERE transport_id = ?",
                    [reqData.route_id, reqData.stop_id, assignedBusId, existingTransport[0].transport_id]
                );
            } else {
                await connection.execute(
                    "INSERT INTO student_transport (student_id, route_id, stop_id, bus_id, status) VALUES (?, ?, ?, ?, 'Active')",
                    [reqData.student_id, reqData.route_id, reqData.stop_id, assignedBusId]
                );
            }

            await connection.execute(
                "UPDATE bus_pass_requests SET status = 'Approved', bus_id = COALESCE(bus_id, ?), reviewed_by = ?, reviewed_at = NOW() WHERE request_id = ?",
                [assignedBusId, adminId, requestId]
            );

            await connection.commit();
            await broadcastStatistics();
            io.emit("busPassesUpdated");
            io.emit("studentsUpdated");
            io.emit("routesUpdated");

            res.json({
                success: true,
                message: "Bus pass approved and generated successfully!",
                pass_id: passId,
                pass_number: passNumber
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Approve bus pass error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.post("/bus-pass-requests/:id/reject", async (req, res) => {
        try {
            const requestId = Number(req.params.id);
            const { remarks } = req.body;

            await db.execute(
                "UPDATE bus_pass_requests SET status = 'Rejected', admin_remarks = ?, reviewed_at = NOW() WHERE request_id = ?",
                [remarks || "Request rejected by administrator.", requestId]
            );

            await broadcastStatistics();
            io.emit("busPassesUpdated");

            res.json({ success: true, message: "Bus pass request rejected." });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.delete("/bus-pass-requests/:id", async (req, res) => {
        try {
            const requestId = Number(req.params.id);
            if (!Number.isInteger(requestId) || requestId <= 0) {
                return res.status(400).json({ success: false, message: "Invalid request ID." });
            }
            const [reqRows] = await db.query(
                "SELECT student_id FROM bus_pass_requests WHERE request_id = ? LIMIT 1",
                [requestId]
            );
            const studentId = reqRows.length > 0 ? reqRows[0].student_id : null;

            await db.execute("DELETE FROM bus_passes WHERE request_id = ?", [requestId]).catch(() => {});
            await db.execute("DELETE FROM bus_pass_requests WHERE request_id = ?", [requestId]);
            await broadcastStatistics();
            io.emit("busPassesUpdated");
            io.emit("passRequestsUpdated");
            res.json({ success: true, message: "Bus pass request deleted successfully." });
        } catch (error) {
            console.error("Delete pass request error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 10. GENERATED BUS PASSES
    // ==========================================
    router.get("/bus-passes", async (req, res) => {
        try {
            const [passes] = await db.query(`
                SELECT
                    bp.pass_id AS id,
                    bp.pass_id,
                    bp.student_id,
                    s.name AS student_name,
                    bp.roll_no,
                    s.branch,
                    s.phone_no,
                    s.email,
                    bp.stop_name,
                    bp.route_name,
                    bp.bus_number,
                    bp.amount_paid,
                    bp.pass_number,
                    bp.issue_date,
                    bp.valid_from,
                    bp.valid_to,
                    bp.status,
                    bp.qr_data,
                    bp.created_at,
                    d.name AS driver_name,
                    d.phone_no AS driver_phone,
                    COALESCE(bpr.passport_photo, (SELECT passport_photo FROM bus_pass_requests WHERE student_id = bp.student_id AND passport_photo IS NOT NULL ORDER BY request_id DESC LIMIT 1)) AS passport_photo
                FROM bus_passes bp
                JOIN students s ON bp.student_id = s.student_id
                LEFT JOIN bus_pass_requests bpr ON bp.request_id = bpr.request_id
                LEFT JOIN buses b ON bp.bus_number = b.bus_number
                LEFT JOIN bus_assignments ba ON b.bus_id = ba.bus_id AND ba.status = 'Active'
                LEFT JOIN drivers d ON ba.driver_id = d.driver_id
                ORDER BY bp.pass_id DESC
            `);

            res.json({
                success: true,
                total: passes.length,
                passes: passes.map(p => ({
                    id: p.pass_id,
                    pass_id: p.pass_id,
                    pass_number: p.pass_number,
                    student_id: p.student_id,
                    student_name: p.student_name,
                    roll_no: p.roll_no,
                    branch: p.branch,
                    phone: p.phone_no,
                    email: p.email,
                    stop: p.stop_name,
                    stop_name: p.stop_name,
                    route: p.route_name,
                    route_name: p.route_name,
                    bus: p.bus_number,
                    bus_number: p.bus_number,
                    driver: p.driver_name || "Unassigned",
                    driver_name: p.driver_name || "Unassigned",
                    passport_photo: p.passport_photo || null,
                    amount_paid: Number(p.amount_paid || 0),
                    issue_date: p.issue_date,
                    valid_from: p.valid_from,
                    valid_to: p.valid_to,
                    status: p.status,
                    qr_data: p.qr_data,
                    created_at: p.created_at
                }))
            });
        } catch (error) {
            console.error("Admin fetch passes error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/bus-passes/:id", async (req, res) => {
        try {
            const passId = Number(req.params.id);
            const [passes] = await db.query(
                `SELECT bp.*, s.name AS student_name, s.branch, s.phone_no, s.email, d.name AS driver_name,
                        COALESCE(bpr.passport_photo, (SELECT passport_photo FROM bus_pass_requests WHERE student_id = bp.student_id AND passport_photo IS NOT NULL ORDER BY request_id DESC LIMIT 1)) AS passport_photo
                 FROM bus_passes bp
                 JOIN students s ON bp.student_id = s.student_id
                 LEFT JOIN bus_pass_requests bpr ON bp.request_id = bpr.request_id
                 LEFT JOIN buses b ON bp.bus_number = b.bus_number
                 LEFT JOIN bus_assignments ba ON b.bus_id = ba.bus_id AND ba.status = 'Active'
                 LEFT JOIN drivers d ON ba.driver_id = d.driver_id
                 WHERE bp.pass_id = ?
                 LIMIT 1`,
                [passId]
            );

            if (!passes.length) {
                return res.status(404).json({ success: false, message: "Bus pass not found." });
            }

            const p = passes[0];
            res.json({
                success: true,
                pass: {
                    id: p.pass_id,
                    pass_id: p.pass_id,
                    pass_number: p.pass_number,
                    student_id: p.student_id,
                    student_name: p.student_name,
                    roll_no: p.roll_no,
                    branch: p.branch,
                    phone: p.phone_no,
                    email: p.email,
                    stop: p.stop_name,
                    stop_name: p.stop_name,
                    route: p.route_name,
                    route_name: p.route_name,
                    bus: p.bus_number,
                    bus_number: p.bus_number,
                    driver: p.driver_name || "Unassigned",
                    driver_name: p.driver_name || "Unassigned",
                    passport_photo: p.passport_photo || null,
                    amount_paid: Number(p.amount_paid || 0),
                    issue_date: p.issue_date,
                    valid_from: p.valid_from,
                    valid_to: p.valid_to,
                    status: p.status,
                    qr_data: p.qr_data,
                    created_at: p.created_at
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.delete("/bus-passes/:id", async (req, res) => {
        try {
            const passId = Number(req.params.id);
            if (!Number.isInteger(passId) || passId <= 0) {
                return res.status(400).json({ success: false, message: "Invalid pass ID." });
            }
            const [passRows] = await db.query(
                "SELECT pass_id, student_id, request_id FROM bus_passes WHERE pass_id = ? LIMIT 1",
                [passId]
            );
            const studentId = passRows.length > 0 ? passRows[0].student_id : null;
            const requestId = passRows.length > 0 ? passRows[0].request_id : null;

            await db.execute("DELETE FROM bus_passes WHERE pass_id = ?", [passId]);

            if (requestId) {
                await db.execute("DELETE FROM bus_pass_requests WHERE request_id = ?", [requestId]).catch(() => {});
            } else if (studentId) {
                await db.execute("DELETE FROM bus_pass_requests WHERE student_id = ?", [studentId]).catch(() => {});
            }

            await broadcastStatistics();
            io.emit("busPassesUpdated");
            io.emit("passRequestsUpdated");
            res.json({ success: true, message: "Bus pass revoked and removed successfully." });
        } catch (error) {
            console.error("Delete bus pass error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 11. LIVE BUS TRACKING
    // ==========================================
    router.get("/live-tracking", async (req, res) => {
        try {
            const [buses] = await db.query(`
                SELECT
                    b.bus_id,
                    b.bus_number,
                    b.bus_name,
                    b.status AS bus_status,
                    d.driver_id,
                    d.name AS driver_name,
                    d.phone_no AS driver_phone,
                    r.route_id,
                    r.route_name,
                    t.trip_id,
                    COALESCE(t.status, 'Idle') AS trip_status,
                    ll.latitude,
                    ll.longitude,
                    ll.speed,
                    ll.heading,
                    ll.recorded_at,
                    TIMESTAMPDIFF(MINUTE, ll.recorded_at, NOW()) AS minutes_ago
                FROM buses b
                LEFT JOIN (
                    SELECT bus_id, MAX(assignment_id) as max_aid
                    FROM bus_assignments
                    WHERE status = 'Active'
                    GROUP BY bus_id
                ) latest_ba ON b.bus_id = latest_ba.bus_id
                LEFT JOIN bus_assignments ba ON latest_ba.max_aid = ba.assignment_id
                LEFT JOIN drivers d ON ba.driver_id = d.driver_id
                LEFT JOIN (
                    SELECT bus_id, MAX(trip_id) as max_tid
                    FROM trips
                    GROUP BY bus_id
                ) latest_trip ON b.bus_id = latest_trip.bus_id
                LEFT JOIN trips t ON latest_trip.max_tid = t.trip_id
                LEFT JOIN routes r ON t.route_id = r.route_id
                LEFT JOIN (
                    SELECT bus_id, MAX(location_id) as max_lid
                    FROM live_locations
                    GROUP BY bus_id
                ) latest_loc ON b.bus_id = latest_loc.bus_id
                LEFT JOIN live_locations ll ON latest_loc.max_lid = ll.location_id
                ORDER BY b.bus_id ASC
            `);

            res.json({
                success: true,
                buses: buses.map(b => {
                    const hasCoord = b.latitude !== null && b.longitude !== null;
                    const isStale = b.minutes_ago === null || b.minutes_ago > 15;
                    return {
                        bus_id: b.bus_id,
                        bus_number: b.bus_number,
                        bus_name: b.bus_name,
                        bus_status: b.bus_status,
                        driver_id: b.driver_id,
                        driver_name: b.driver_name || "Unassigned",
                        driver_phone: b.driver_phone || "N/A",
                        route_id: b.route_id,
                        route_name: b.route_name || "Unassigned",
                        trip_id: b.trip_id,
                        trip_status: b.trip_status,
                        latitude: hasCoord ? Number(b.latitude) : null,
                        longitude: hasCoord ? Number(b.longitude) : null,
                        speed: b.speed ? Number(b.speed) : 0,
                        heading: b.heading ? Number(b.heading) : 0,
                        recorded_at: b.recorded_at,
                        minutes_ago: b.minutes_ago,
                        is_stale: isStale,
                        is_live: hasCoord && !isStale && b.trip_status === "Started"
                    };
                })
            });
        } catch (error) {
            console.error("Live tracking error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 12. REPORTS AND ANALYTICS
    // ==========================================
    router.get("/reports/summary", async (req, res) => {
        try {
            const [
                [fleetStats],
                routeLoad,
                [revenueStats],
                [payrollStats]
            ] = await Promise.all([
                db.query(`
                    SELECT
                        COUNT(*) AS total_buses,
                        SUM(CASE WHEN status IN ('Active', 'Available') THEN 1 ELSE 0 END) AS working_buses,
                        SUM(CASE WHEN status NOT IN ('Active', 'Available') THEN 1 ELSE 0 END) AS not_working_buses,
                        SUM(CASE WHEN status = 'Maintenance' THEN 1 ELSE 0 END) AS maintenance_buses,
                        SUM(capacity) AS total_capacity
                    FROM buses
                `),
                db.query(`
                    SELECT
                        r.route_id,
                        r.route_name,
                        COUNT(DISTINCT st.student_id) AS student_count,
                        COUNT(DISTINCT CASE WHEN s.status = 'Active' THEN rs.stop_id END) AS stop_count,
                        GROUP_CONCAT(DISTINCT b.bus_number SEPARATOR ', ') AS buses
                    FROM routes r
                    LEFT JOIN route_stops rs ON r.route_id = rs.route_id
                    LEFT JOIN stops s ON rs.stop_id = s.stop_id
                    LEFT JOIN (
                        SELECT st.student_id, st.route_id, st.status
                        FROM student_transport st
                        INNER JOIN (
                            SELECT student_id, MAX(transport_id) AS latest_transport_id
                            FROM student_transport
                            GROUP BY student_id
                        ) latest ON latest.latest_transport_id = st.transport_id
                    ) st ON r.route_id = st.route_id
                        AND st.status IN ('Active', 'Pending')
                    LEFT JOIN buses b ON r.route_id = b.route_id
                        AND b.status IN ('Active', 'Available')
                    WHERE r.status <> 'Deleted'
                    GROUP BY r.route_id
                    ORDER BY student_count DESC
                `),
                db.query(`
                    SELECT
                        COALESCE(SUM(CASE WHEN payment_status = 'Success' THEN amount ELSE 0 END), 0) AS total_collected,
                        COALESCE(SUM(CASE WHEN payment_status = 'Pending' THEN amount ELSE 0 END), 0) AS pending_verification,
                        COUNT(CASE WHEN payment_status = 'Success' THEN 1 END) AS successful_count,
                        COUNT(CASE WHEN payment_status = 'Pending' THEN 1 END) AS pending_count
                    FROM payments
                `),
                db.query(`
                    SELECT
                        COUNT(*) AS total_drivers,
                        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS active_drivers,
                        COALESCE(SUM(CASE WHEN status = 'Active' THEN salary ELSE 0 END), 0) AS monthly_payroll
                    FROM drivers
                `)
            ]);

            res.json({
                success: true,
                fleet: fleetStats[0],
                route_load: routeLoad[0],
                revenue: revenueStats[0],
                payroll: payrollStats[0]
            });
        } catch (error) {
            console.error("Reports error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // 13. TRANSPORTATION CANCELLATIONS
    // ==========================================
    router.get("/cancellations", async (req, res) => {
        try {
            const [cancellations] = await db.query(`
                SELECT
                    tc.cancellation_id,
                    tc.student_id,
                    tc.student_transport_id,
                    tc.pass_id,
                    tc.reason,
                    tc.status,
                    tc.admin_remarks,
                    COALESCE(tc.fine_amount, 0) AS fine_amount,
                    COALESCE(tc.fine_payment_status, 'Pending') AS fine_payment_status,
                    tc.fine_paid_at,
                    tc.fine_transaction_id,
                    tc.requested_at,
                    tc.reviewed_at,
                    s.name AS student_name,
                    s.roll_no,
                    s.email AS student_email,
                    s.phone_no AS student_phone,
                    s.branch,
                    s.year,
                    bp.pass_number,
                    bp.amount_paid,
                    bp.status AS pass_status,
                    r.route_name,
                    r.start_location,
                    r.end_location,
                    sp.stop_name,
                    b.bus_number
                FROM transport_cancellations tc
                JOIN students s ON tc.student_id = s.student_id
                LEFT JOIN bus_passes bp ON (tc.pass_id IS NOT NULL AND tc.pass_id = bp.pass_id) OR (tc.pass_id IS NULL AND bp.student_id = tc.student_id AND bp.status = 'Active')
                LEFT JOIN student_transport st ON tc.student_transport_id = st.transport_id
                LEFT JOIN routes r ON (bp.route_id = r.route_id OR st.route_id = r.route_id)
                LEFT JOIN stops sp ON (bp.stop_id = sp.stop_id OR st.stop_id = sp.stop_id)
                LEFT JOIN buses b ON (bp.bus_id = b.bus_id OR st.bus_id = b.bus_id)
                ORDER BY tc.requested_at DESC, tc.cancellation_id DESC
            `);

            res.json({
                success: true,
                cancellations: cancellations.map(c => ({
                    ...c,
                    fine_amount: Number(c.fine_amount || 0),
                    fine_payment_status: c.fine_payment_status || "Pending",
                    amount_paid: Number(c.amount_paid || 0)
                }))
            });
        } catch (error) {
            console.error("Admin fetch cancellations error:", error);
            res.status(500).json({ success: false, message: "Unable to load cancellations." });
        }
    });

    router.post("/cancellations/:id/approve", async (req, res) => {
        let connection;
        try {
            const cancellationId = Number(req.params.id);
            if (!Number.isInteger(cancellationId) || cancellationId <= 0) {
                return res.status(400).json({ success: false, message: "Invalid cancellation ID." });
            }

            const { fine_amount, remarks } = req.body || {};
            // Configurable institutional cancellation fine rule: default ₹500, min ₹0
            const parsedFine = Number(fine_amount !== undefined ? fine_amount : 500);
            if (!Number.isFinite(parsedFine) || parsedFine < 0) {
                return res.status(400).json({
                    success: false,
                    message: "Please specify a valid fine amount (₹0 or greater)."
                });
            }

            const adminRemarks = String(remarks || "Cancellation approved by Administration.").trim().slice(0, 255);

            connection = await db.getConnection();
            await connection.beginTransaction();

            // Lock and fetch current request
            const [rows] = await connection.execute(
                "SELECT cancellation_id, student_id, pass_id, status FROM transport_cancellations WHERE cancellation_id = ? FOR UPDATE",
                [cancellationId]
            );

            if (rows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: "Cancellation request not found." });
            }

            const request = rows[0];
            if (request.status !== "Pending") {
                await connection.rollback();
                return res.status(409).json({
                    success: false,
                    message: `This cancellation request has already been ${request.status.toLowerCase()} and cannot be approved again.`
                });
            }

            // 1. Update cancellation record
            await connection.execute(
                `UPDATE transport_cancellations
                 SET status = 'Approved', fine_amount = ?, fine_payment_status = 'Pending', admin_remarks = ?, reviewed_at = NOW()
                 WHERE cancellation_id = ? AND status = 'Pending'`,
                [parsedFine, adminRemarks, cancellationId]
            );

            // 2. Deactivate the student's bus pass
            await connection.execute(
                "UPDATE bus_passes SET status = 'Cancelled' WHERE student_id = ? AND status = 'Active'",
                [request.student_id]
            );

            // 3. Deactivate the student's transportation assignment
            await connection.execute(
                "UPDATE student_transport SET status = 'Cancelled' WHERE student_id = ?",
                [request.student_id]
            );

            // 4. Create in-app notification for the student
            await connection.execute(
                `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, created_at)
                 VALUES ('student', ?, 'Bus Pass Cancellation Approved', ?, 'CANCELLATION', 'admin', NOW())`,
                [
                    request.student_id,
                    `Your bus pass cancellation has been approved. Applicable cancellation fee: ₹${parsedFine.toLocaleString("en-IN")}. Your bus pass and transportation assignment have been deactivated.`
                ]
            );

            await connection.commit();

            // Broadcast Socket.IO update
            io.emit("cancellationUpdated", {
                cancellation_id: cancellationId,
                student_id: request.student_id,
                status: "Approved",
                fine_amount: parsedFine,
                admin_remarks: adminRemarks
            });

            // Update stats
            if (typeof broadcastStatistics === "function") {
                broadcastStatistics();
            }

            res.json({
                success: true,
                message: "Cancellation request approved successfully. Bus pass deactivated and fine applied.",
                fine_amount: parsedFine
            });
        } catch (error) {
            if (connection) await connection.rollback();
            console.error("Approve cancellation error:", error);
            res.status(500).json({ success: false, message: "Unable to approve cancellation request." });
        } finally {
            if (connection) connection.release();
        }
    });

    router.post("/cancellations/:id/reject", async (req, res) => {
        let connection;
        try {
            const cancellationId = Number(req.params.id);
            if (!Number.isInteger(cancellationId) || cancellationId <= 0) {
                return res.status(400).json({ success: false, message: "Invalid cancellation ID." });
            }

            const { remarks } = req.body || {};
            const adminRemarks = String(remarks || "Cancellation request rejected by Administration.").trim().slice(0, 255);

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [rows] = await connection.execute(
                "SELECT cancellation_id, student_id, status FROM transport_cancellations WHERE cancellation_id = ? FOR UPDATE",
                [cancellationId]
            );

            if (rows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: "Cancellation request not found." });
            }

            const request = rows[0];
            if (request.status !== "Pending") {
                await connection.rollback();
                return res.status(409).json({
                    success: false,
                    message: `This cancellation request has already been ${request.status.toLowerCase()}.`
                });
            }

            // Update cancellation status to Rejected - Bus pass and transport remain ACTIVE
            await connection.execute(
                `UPDATE transport_cancellations
                 SET status = 'Rejected', fine_amount = 0.00, admin_remarks = ?, reviewed_at = NOW()
                 WHERE cancellation_id = ? AND status = 'Pending'`,
                [adminRemarks, cancellationId]
            );

            // Notify student
            await connection.execute(
                `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, created_at)
                 VALUES ('student', ?, 'Bus Pass Cancellation Rejected', ?, 'CANCELLATION', 'admin', NOW())`,
                [
                    request.student_id,
                    `Your cancellation request was rejected. Remarks: ${adminRemarks}. Your existing bus pass and van transportation remain active.`
                ]
            );

            await connection.commit();

            io.emit("cancellationUpdated", {
                cancellation_id: cancellationId,
                student_id: request.student_id,
                status: "Rejected",
                fine_amount: 0,
                admin_remarks: adminRemarks
            });

            res.json({
                success: true,
                message: "Cancellation request rejected. Student bus pass remains active."
            });
        } catch (error) {
            if (connection) await connection.rollback();
            console.error("Reject cancellation error:", error);
            res.status(500).json({ success: false, message: "Unable to reject cancellation request." });
        } finally {
            if (connection) connection.release();
        }
    });

    // ==========================================
    // 14. DIESEL RECORDS (ADMIN VIEW)
    // ==========================================
    router.get("/diesel", async (req, res) => {
        try {
            const [records] = await db.query(`
                SELECT
                    dr.diesel_id,
                    dr.bus_id,
                    b.bus_number,
                    b.bus_name,
                    dr.driver_id,
                    d.name AS driver_name,
                    d.phone_no AS driver_phone,
                    dr.litres,
                    dr.cost,
                    dr.entry_date,
                    dr.notes,
                    dr.created_at
                FROM diesel_records dr
                JOIN buses b ON dr.bus_id = b.bus_id
                JOIN drivers d ON dr.driver_id = d.driver_id
                ORDER BY dr.entry_date DESC, dr.diesel_id DESC
            `);

            const totalLitres = records.reduce((sum, r) => sum + Number(r.litres || 0), 0);
            const totalCost = records.reduce((sum, r) => sum + Number(r.cost || 0), 0);

            res.json({
                success: true,
                records: records.map(r => ({
                    id: r.diesel_id,
                    diesel_id: r.diesel_id,
                    bus_id: r.bus_id,
                    bus_number: r.bus_number,
                    bus_name: r.bus_name,
                    driver_id: r.driver_id,
                    driver_name: r.driver_name,
                    driver_phone: r.driver_phone,
                    litres: Number(r.litres || 0),
                    cost: r.cost !== null ? Number(r.cost) : null,
                    entry_date: r.entry_date,
                    notes: r.notes || "—",
                    created_at: r.created_at
                })),
                summary: {
                    total_entries: records.length,
                    total_litres: totalLitres,
                    total_cost: totalCost
                }
            });
        } catch (error) {
            console.error("Admin fetch diesel records error:", error);
            res.status(500).json({ success: false, message: "Unable to load diesel records." });
        }
    });

    // ==========================================
    // 15. NOTIFICATIONS SYSTEM
    // ==========================================
    router.get("/notifications", async (req, res) => {
        try {
            const [notifications] = await db.query(`
                SELECT
                    n.notification_id,
                    n.user_role,
                    n.user_id,
                    n.title,
                    n.message,
                    n.type,
                    n.sender_role,
                    n.sender_id,
                    n.bus_id,
                    n.route_id,
                    n.is_public,
                    n.is_read,
                    n.created_at,
                    b.bus_number,
                    r.route_name
                FROM notifications n
                LEFT JOIN buses b ON n.bus_id = b.bus_id
                LEFT JOIN routes r ON n.route_id = r.route_id
                ORDER BY n.created_at DESC
                LIMIT 100
            `);

            res.json({
                success: true,
                notifications
            });
        } catch (error) {
            console.error("Admin fetch notifications error:", error);
            res.status(500).json({ success: false, message: "Unable to load notifications." });
        }
    });

    router.get("/notifications/recipients", async (req, res) => {
        try {
            const [routes] = await db.query("SELECT route_id, route_name FROM routes WHERE status NOT IN ('Deleted') AND status = 'Active' ORDER BY route_name");
            const [buses] = await db.query("SELECT bus_id, bus_number, bus_name FROM buses WHERE status = 'Active' ORDER BY bus_number");

            res.json({
                success: true,
                routes,
                buses
            });
        } catch (error) {
            console.error("Fetch recipients error:", error);
            res.status(500).json({ success: false, message: "Unable to load recipient options." });
        }
    });

    router.post("/notifications", async (req, res) => {
        try {
            const { title, message, audience, route_id, bus_id, user_id, is_public } = req.body || {};

            const cleanTitle = String(title || "").trim().slice(0, 120);
            const cleanMessage = String(message || "").trim().slice(0, 500);

            if (!cleanTitle) {
                return res.status(400).json({ success: false, message: "Please provide a notification title." });
            }
            if (!cleanMessage) {
                return res.status(400).json({ success: false, message: "Please provide notification message content." });
            }

            const notifCategory = req.body.type || "GENERAL";
            const targetAudience = String(audience || "students").toLowerCase().trim();
            const isPublicFlag = (is_public || targetAudience === "public") ? 1 : 0;
            const createdIds = [];

            if (targetAudience === "students" || targetAudience === "all_students") {
                const [res1] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', 0, ?, ?, ?, 'admin', ?, NOW())`,
                    [cleanTitle, cleanMessage, notifCategory, isPublicFlag]
                );
                createdIds.push(res1.insertId);
            } else if (targetAudience === "drivers" || targetAudience === "all_drivers") {
                const [res2] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('driver', 0, ?, ?, ?, 'admin', ?, NOW())`,
                    [cleanTitle, cleanMessage, notifCategory, isPublicFlag]
                );
                createdIds.push(res2.insertId);
            } else if (targetAudience === "all" || targetAudience === "all_users") {
                const [res3] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', 0, ?, ?, ?, 'admin', ?, NOW())`,
                    [cleanTitle, cleanMessage, notifCategory, isPublicFlag]
                );
                const [res4] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('driver', 0, ?, ?, ?, 'admin', ?, NOW())`,
                    [cleanTitle, cleanMessage, notifCategory, isPublicFlag]
                );
                createdIds.push(res3.insertId, res4.insertId);
            } else if (targetAudience === "route" || targetAudience === "route_students") {
                const routeIdNum = Number(route_id);
                if (!routeIdNum) {
                    return res.status(400).json({ success: false, message: "Please select a route." });
                }
                const [res5] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, route_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', 0, ?, ?, ?, ?, 'admin', ?, NOW())`,
                    [routeIdNum, cleanTitle, cleanMessage, notifCategory || 'ROUTE', isPublicFlag]
                );
                createdIds.push(res5.insertId);
            } else if (targetAudience === "bus" || targetAudience === "bus_students") {
                const busIdNum = Number(bus_id);
                if (!busIdNum) {
                    return res.status(400).json({ success: false, message: "Please select a bus." });
                }
                const [res6] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, bus_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', 0, ?, ?, ?, ?, 'admin', ?, NOW())`,
                    [busIdNum, cleanTitle, cleanMessage, notifCategory || 'BUS', isPublicFlag]
                );
                createdIds.push(res6.insertId);
            } else if (targetAudience === "public") {
                const [resPub] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', 0, ?, ?, ?, 'admin', 1, NOW())`,
                    [cleanTitle, cleanMessage, notifCategory]
                );
                createdIds.push(resPub.insertId);
            } else if (targetAudience === "specific_student") {
                const studentIdNum = Number(user_id);
                if (!studentIdNum) {
                    return res.status(400).json({ success: false, message: "Please specify student ID." });
                }
                const [res7] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', ?, ?, ?, ?, 'admin', ?, NOW())`,
                    [studentIdNum, cleanTitle, cleanMessage, notifCategory || 'DIRECT', isPublicFlag]
                );
                createdIds.push(res7.insertId);
            } else {
                // Default fallback to student broadcast
                const [resDef] = await db.execute(
                    `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, is_public, created_at)
                     VALUES ('student', 0, ?, ?, ?, 'admin', ?, NOW())`,
                    [cleanTitle, cleanMessage, notifCategory, isPublicFlag]
                );
                createdIds.push(resDef.insertId);
            }

            // Real-time delivery via Socket.IO
            io.emit("newNotification", {
                notification_id: createdIds[0],
                title: cleanTitle,
                message: cleanMessage,
                type: notifCategory,
                audience: targetAudience,
                is_public: isPublicFlag,
                route_id: (targetAudience === "route" || targetAudience === "route_students") ? Number(route_id) : null,
                bus_id: (targetAudience === "bus" || targetAudience === "bus_students") ? Number(bus_id) : null,
                sender_role: "admin",
                created_at: new Date().toISOString()
            });

            res.status(201).json({
                success: true,
                message: "Notification created and delivered successfully.",
                created_count: createdIds.length
            });
        } catch (error) {
            console.error("Create notification error:", error);
            res.status(500).json({ success: false, message: "Unable to create notification." });
        }
    });

    router.patch("/notifications/:id/read", async (req, res) => {
        try {
            const notifId = Number(req.params.id);
            await db.execute("UPDATE notifications SET is_read = 1 WHERE notification_id = ?", [notifId]);
            res.json({ success: true, message: "Notification marked as read." });
        } catch (error) {
            console.error("Admin mark notification read error:", error);
            res.status(500).json({ success: false, message: "Unable to update notification." });
        }
    });

    // ==========================================
    // 16. CONTACT MESSAGES / INQUIRIES
    // ==========================================
    router.get("/contact-messages", async (req, res) => {
        try {
            const [messages] = await db.execute(
                `SELECT message_id AS id, message_id, name, email, message, is_read, created_at FROM contact_messages ORDER BY created_at DESC`
            );
            res.json({ success: true, messages });
        } catch (error) {
            console.error("Admin fetch contact messages error:", error);
            res.status(500).json({ success: false, message: "Unable to load contact messages." });
        }
    });

    router.patch("/contact-messages/:id/read", async (req, res) => {
        try {
            const id = Number(req.params.id);
            await db.execute("UPDATE contact_messages SET is_read = 1 WHERE message_id = ?", [id]);
            if (typeof broadcastStatistics === "function") {
                broadcastStatistics().catch(() => {});
            }
            res.json({ success: true, message: "Message marked as read." });
        } catch (error) {
            console.error("Admin mark message read error:", error);
            res.status(500).json({ success: false, message: "Unable to update message." });
        }
    });

    router.delete("/contact-messages/:id", async (req, res) => {
        try {
            const id = Number(req.params.id);
            await db.execute("DELETE FROM contact_messages WHERE message_id = ?", [id]);
            if (typeof broadcastStatistics === "function") {
                broadcastStatistics().catch(() => {});
            }
            res.json({ success: true, message: "Message deleted successfully." });
        } catch (error) {
            console.error("Admin delete message error:", error);
            res.status(500).json({ success: false, message: "Unable to delete message." });
        }
    });

    // Mount router onto the main app
    app.use("/api/admin", router);
}

module.exports = { registerAdminRoutes, calculateDistanceFee, FEE_SLABS };
