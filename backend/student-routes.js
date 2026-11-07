"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const PASSPORT_PHOTOS_DIR = path.join(__dirname, "uploads", "passport-photos");
fs.mkdirSync(PASSPORT_PHOTOS_DIR, { recursive: true });

// CHANGE 1: Multer storage for student passport photos
const passportStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, PASSPORT_PHOTOS_DIR);
    },
    filename: (req, file, cb) => {
        const studentId = req.student?.student_id || "student";
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${studentId}-${Date.now()}${ext}`);
    }
});

const uploadPassport = multer({
    storage: passportStorage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
    fileFilter: (req, file, cb) => {
        const allowedExts = [".jpg", ".jpeg", ".png", ".webp"];
        const ext = path.extname(file.originalname).toLowerCase();
        const mime = (file.mimetype || "").toLowerCase();
        const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
        if (allowedExts.includes(ext) && (allowedMimes.includes(mime) || mime.startsWith("image/"))) {
            cb(null, true);
        } else {
            cb(new Error("Invalid file type. Only JPG, JPEG, PNG, and WEBP image files are allowed."));
        }
    }
});

function handlePassportUpload(req, res, next) {
    uploadPassport.single("passport_photo")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ success: false, message: "Photo file size exceeds the 2 MB limit." });
            }
            return res.status(400).json({ success: false, message: err.message });
        } else if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        next();
    });
}

// CHANGE 4: Helper to verify if student's bus pass is cancelled in DB
async function isStudentPassCancelled(dbPool, studentId) {
    if (!studentId) return false;
    try {
        const [passes] = await dbPool.query(
            "SELECT status FROM bus_passes WHERE student_id = ? ORDER BY pass_id DESC LIMIT 1",
            [studentId]
        );
        if (passes.length > 0 && String(passes[0].status).toLowerCase().includes("cancel")) {
            return true;
        }
        const [cancels] = await dbPool.query(
            "SELECT cancellation_id FROM transport_cancellations WHERE student_id = ? AND status = 'Approved' LIMIT 1",
            [studentId]
        );
        if (cancels.length > 0) {
            const [active] = await dbPool.query(
                "SELECT pass_id FROM bus_passes WHERE student_id = ? AND status = 'Active' LIMIT 1",
                [studentId]
            );
            if (active.length === 0) return true;
        }
    } catch (err) {
        console.error("isStudentPassCancelled check error:", err.message);
    }
    return false;
}

/**
 * Fallback fee calculator based on distance in km
 */
function calculateFeeByDistance(km) {
    const d = Number(km || 0);
    if (d <= 5) return 8000;
    if (d <= 10) return 12000;
    if (d <= 15) return 15000;
    if (d <= 20) return 18000;
    return 22000;
}

function registerStudentRoutes(app, db, io, broadcastStatistics) {
    const router = express.Router();

    /**
     * Authentication Guard Middleware for Students:
     * Verifies student identity and ensures account is active in MySQL.
     */
    async function authStudent(req, res, next) {
        try {
            const rawId =
                req.headers["x-student-id"] ||
                req.headers["student-id"] ||
                req.query.student_id ||
                (req.body && req.body.student_id);

            const studentId = Number(rawId);

            if (!Number.isInteger(studentId) || studentId <= 0) {
                return res.status(401).json({
                    success: false,
                    message: "Student authentication required. Please sign in."
                });
            }

            const [rows] = await db.execute(
                `
                SELECT
                    student_id,
                    name,
                    branch,
                    year,
                    roll_no,
                    phone_no,
                    email,
                    residential_address,
                    status,
                    created_at
                FROM students
                WHERE student_id = ?
                LIMIT 1
                `,
                [studentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Student account not found in database."
                });
            }

            const student = rows[0];

            if (student.status && String(student.status).toLowerCase() !== "active") {
                return res.status(403).json({
                    success: false,
                    message: "Your student account is deactivated. Contact Transportation Office."
                });
            }

            req.student = student;
            next();
        } catch (error) {
            console.error("Student auth middleware error:", error);
            res.status(500).json({ success: false, message: "Authentication validation error." });
        }
    }

    /**
     * Helper to retrieve student's transport assignment, bus, route, and driver
     */
    async function getStudentTransportDetails(studentId) {
        const [rows] = await db.query(
            `
            SELECT
                st.transport_id,
                st.status AS transport_status,
                st.route_id,
                r.route_name,
                r.start_location,
                r.end_location,
                r.status AS route_status,
                st.stop_id,
                sp.stop_name,
                sp.location AS stop_location,
                sp.distance_km,
                sp.latitude AS stop_lat,
                sp.longitude AS stop_lng,
                st.bus_id,
                b.bus_number,
                b.bus_name,
                b.capacity AS bus_capacity,
                b.status AS bus_status,
                d.driver_id,
                d.name AS driver_name,
                d.phone_no AS driver_phone,
                d.email AS driver_email,
                d.status AS driver_status,
                d.license_no AS driver_license,
                d.experience AS driver_experience,
                ba.assignment_id,
                ba.status AS assignment_status
            FROM student_transport st
            LEFT JOIN routes r ON st.route_id = r.route_id
            LEFT JOIN stops sp ON st.stop_id = sp.stop_id
            LEFT JOIN buses b ON st.bus_id = b.bus_id
            LEFT JOIN bus_assignments ba ON ba.bus_id = b.bus_id AND (ba.status = 'Active' OR ba.status IS NOT NULL)
            LEFT JOIN drivers d ON ba.driver_id = d.driver_id
            WHERE st.student_id = ?
            ORDER BY st.transport_id DESC
            LIMIT 1
            `,
            [studentId]
        );

        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Helper to compute accurate fee information for a student
     */
    async function getStudentFeeInfo(studentId, stopId, distanceKm) {
        let applicableFee = 0;

        if (stopId) {
            const [feeRows] = await db.query(
                `SELECT amount FROM fees WHERE stop_id = ? AND status = 'Active' ORDER BY fee_id DESC LIMIT 1`,
                [stopId]
            );

            if (feeRows.length > 0) {
                applicableFee = Number(feeRows[0].amount || 0);
            }
        }

        if (applicableFee <= 0 && distanceKm) {
            applicableFee = calculateFeeByDistance(distanceKm);
        }

        // Sum of all successful payments
        const [paidRows] = await db.query(
            `SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE student_id = ? AND payment_status = 'Success'`,
            [studentId]
        );

        const totalPaid = Number(paidRows[0].total_paid || 0);
        const outstanding = Math.max(0, applicableFee - totalPaid);

        let paymentStatus = "Unpaid";
        if (applicableFee > 0 && outstanding === 0) {
            paymentStatus = "Paid";
        } else if (totalPaid > 0 && outstanding > 0) {
            paymentStatus = "Partial";
        } else if (applicableFee === 0) {
            paymentStatus = "N/A";
        }

        return {
            applicable_fee: applicableFee,
            amount_paid: totalPaid,
            outstanding_amount: outstanding,
            payment_status: paymentStatus
        };
    }

    // =========================================================
    // 1. GET STUDENT PROFILE
    // =========================================================
    router.get("/profile", authStudent, async (req, res) => {
        try {
            const student = req.student;
            const transport = await getStudentTransportDetails(student.student_id);

            res.json({
                success: true,
                student: {
                    id: student.student_id,
                    student_id: student.student_id,
                    name: student.name,
                    roll_no: student.roll_no,
                    branch: student.branch,
                    year: student.year,
                    phone_no: student.phone_no,
                    email: student.email,
                    residential_address: student.residential_address,
                    status: student.status,
                    created_at: student.created_at,
                    route: transport ? transport.route_name : "Not Assigned",
                    stop: transport ? transport.stop_name : "Not Selected",
                    bus: transport ? transport.bus_number : "Not Assigned"
                }
            });
        } catch (error) {
            console.error("Fetch student profile error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 2. PATCH STUDENT PROFILE (STRICTLY NAME & MOBILE NUMBER ONLY)
    // =========================================================
    router.patch("/profile", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const { name, phone_no, phone } = req.body;

            const newName = (name !== undefined ? String(name) : req.student.name).trim();
            const newPhone = (phone_no !== undefined ? String(phone_no) : (phone !== undefined ? String(phone) : req.student.phone_no)).trim();

            if (!newName || newName.length < 2) {
                return res.status(400).json({
                    success: false,
                    message: "Student name must contain at least 2 characters."
                });
            }

            if (!/^[0-9]{10}$/.test(newPhone)) {
                return res.status(400).json({
                    success: false,
                    message: "Mobile number must contain exactly 10 digits."
                });
            }

            // Check if another student is already using this phone number
            const [existing] = await db.execute(
                "SELECT student_id FROM students WHERE phone_no = ? AND student_id != ? LIMIT 1",
                [newPhone, studentId]
            );

            if (existing.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: "This mobile number is already registered by another student."
                });
            }

            // Update ONLY name and phone_no. All other fields (roll_no, email, branch, status) are strictly preserved!
            await db.execute(
                "UPDATE students SET name = ?, phone_no = ? WHERE student_id = ?",
                [newName, newPhone, studentId]
            );

            // Fetch updated record
            const [updatedRows] = await db.execute(
                "SELECT student_id, name, branch, year, roll_no, phone_no, email, residential_address, status FROM students WHERE student_id = ?",
                [studentId]
            );

            const updatedStudent = updatedRows[0];

            // Notify real-time subscribers
            io.emit("studentProfileUpdated", {
                student_id: studentId,
                name: newName,
                phone_no: newPhone
            });
            await broadcastStatistics();

            res.json({
                success: true,
                message: "Profile updated successfully. Only Name and Mobile Number were modified.",
                student: updatedStudent
            });
        } catch (error) {
            console.error("Update student profile error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 2B. PUT STUDENT ROUTE & STOP (EDIT ONLY ROUTE/STOP)
    // =========================================================
    router.put("/route-stop", authStudent, async (req, res) => {
        let connection;
        try {
            const studentId = req.student.student_id;
            const { route_id, stop_id } = req.body;

            const routeId = Number(route_id);
            const stopId = Number(stop_id);

            // Validate inputs
            if (!Number.isInteger(routeId) || routeId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "A valid route must be selected."
                });
            }
            if (!Number.isInteger(stopId) || stopId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "A valid boarding stop must be selected."
                });
            }

            // Server-side: verify route is active
            const [routeRows] = await db.query(
                "SELECT route_id, route_name, start_location, end_location, status FROM routes WHERE route_id = ? LIMIT 1",
                [routeId]
            );
            if (routeRows.length === 0 || routeRows[0].status !== "Active") {
                return res.status(400).json({
                    success: false,
                    message: "The selected route is not active or does not exist."
                });
            }

            // Server-side: verify stop belongs to the selected route
            const [stopRows] = await db.query(
                `SELECT s.stop_id, s.stop_name, s.distance_km
                 FROM route_stops rs
                 JOIN stops s ON rs.stop_id = s.stop_id
                 WHERE rs.route_id = ? AND rs.stop_id = ? AND s.status = 'Active'
                 LIMIT 1`,
                [routeId, stopId]
            );
            if (stopRows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "The selected boarding stop does not belong to the chosen route."
                });
            }

            // Get fee for new stop
            const [feeRows] = await db.query(
                "SELECT fee_id, amount FROM fees WHERE stop_id = ? AND status = 'Active' ORDER BY fee_id DESC LIMIT 1",
                [stopId]
            );
            const newFeeAmount = feeRows.length > 0
                ? Number(feeRows[0].amount || 0)
                : calculateFeeByDistance(stopRows[0].distance_km);

            // Run update in a transaction
            connection = await db.getConnection();
            await connection.beginTransaction();

            // Only update the route and stop; bus_id and status remain unchanged
            const [existTransport] = await connection.query(
                "SELECT transport_id, bus_id, status FROM student_transport WHERE student_id = ? LIMIT 1",
                [studentId]
            );

            if (existTransport.length > 0) {
                await connection.execute(
                    "UPDATE student_transport SET route_id = ?, stop_id = ?, route_changed = 1 WHERE student_id = ?",
                    [routeId, stopId, studentId]
                );
            } else {
                await connection.execute(
                    "INSERT INTO student_transport (student_id, route_id, stop_id, route_changed, status) VALUES (?, ?, ?, 1, 'Pending')",
                    [studentId, routeId, stopId]
                );
            }

            await connection.commit();

            // Fetch updated full transport details to return to the client
            const updatedTransport = await getStudentTransportDetails(studentId);
            const feeInfo = await getStudentFeeInfo(
                studentId,
                updatedTransport ? updatedTransport.stop_id : stopId,
                updatedTransport ? updatedTransport.distance_km : stopRows[0].distance_km
            );

            // Notify real-time subscribers
            io.emit("studentTransportUpdated", { student_id: studentId });
            await broadcastStatistics();

            const feeNotSet = newFeeAmount <= 0;
            const feeMsg = feeNotSet
                ? "Fee not set"
                : `Route changed. Fee for the new route: ₹${newFeeAmount.toLocaleString("en-IN")}`;

            res.json({
                success: true,
                message: `Route and boarding stop updated successfully. ${feeMsg}`,
                fee_message: feeMsg,
                transport: updatedTransport ? {
                    route_id: updatedTransport.route_id,
                    route_name: updatedTransport.route_name,
                    stop_id: updatedTransport.stop_id,
                    stop_name: updatedTransport.stop_name,
                    distance_km: Number(updatedTransport.distance_km || 0),
                    bus_id: updatedTransport.bus_id,
                    bus_number: updatedTransport.bus_number,
                    bus_status: updatedTransport.bus_status,
                    driver_name: updatedTransport.driver_name,
                    driver_phone: updatedTransport.driver_phone,
                    driver_status: updatedTransport.driver_status,
                    route_status: updatedTransport.route_status
                } : null,
                fee: feeInfo
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Update student route-stop error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // =========================================================
    // 3. GET DASHBOARD SUMMARY METRICS
    // =========================================================
    router.get("/dashboard-summary", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const transport = await getStudentTransportDetails(studentId);

            const stopId = transport?.stop_id || null;
            const distanceKm = transport?.distance_km || 0;
            const feeInfo = await getStudentFeeInfo(studentId, stopId, distanceKm);

            // Check latest bus pass request
            const [reqRows] = await db.query(
                "SELECT request_id, status, admin_remarks, requested_at FROM bus_pass_requests WHERE student_id = ? ORDER BY request_id DESC LIMIT 1",
                [studentId]
            );
            const latestRequest = reqRows.length > 0 ? reqRows[0] : null;

            // Check route_changed flag — suppress old pass when route was changed but not yet paid
            const [rcRows2] = await db.query(
                "SELECT route_changed FROM student_transport WHERE student_id = ? LIMIT 1",
                [studentId]
            );
            const routeChangedFlag = rcRows2.length > 0 && Number(rcRows2[0].route_changed) === 1;

            // Check latest active bus pass (suppress if route_changed — old pass pending replacement)
            const [passRows] = await db.query(
                "SELECT pass_id, pass_number, valid_from, valid_to, status FROM bus_passes WHERE student_id = ? AND status = 'Active' ORDER BY pass_id DESC LIMIT 1",
                [studentId]
            );
            const activePass = (!routeChangedFlag && passRows.length > 0) ? passRows[0] : null;

            // Check if assigned bus currently has an active trip
            let activeTrip = null;
            if (transport && transport.bus_id) {
                const [tripRows] = await db.query(
                    "SELECT trip_id, status, start_time FROM trips WHERE bus_id = ? AND status = 'Started' ORDER BY trip_id DESC LIMIT 1",
                    [transport.bus_id]
                );
                if (tripRows.length > 0) {
                    activeTrip = tripRows[0];
                }
            }

            // Check if student profile/pass is cancelled
            const isCancelled = await isStudentPassCancelled(db, studentId);

            res.json({
                success: true,
                is_profile_inactive: isCancelled,
                route_changed: routeChangedFlag,
                student: {
                    id: req.student.student_id,
                    student_id: req.student.student_id,
                    name: req.student.name,
                    roll_no: req.student.roll_no,
                    branch: req.student.branch,
                    year: req.student.year,
                    phone_no: req.student.phone_no,
                    email: req.student.email,
                    residential_address: req.student.residential_address,
                    status: req.student.status,
                    created_at: req.student.created_at
                },
                transport: transport ? {
                    route_id: transport.route_id,
                    route_name: transport.route_name,
                    stop_id: transport.stop_id,
                    stop_name: transport.stop_name,
                    distance_km: Number(transport.distance_km || 0),
                    bus_id: transport.bus_id,
                    bus_number: transport.bus_number,
                    bus_status: transport.bus_status,
                    driver_name: transport.driver_name,
                    driver_phone: transport.driver_phone,
                    driver_status: transport.driver_status
                } : null,
                fee: feeInfo,
                bus_request: {
                    status: (activePass && activePass.status === 'Active')
                        ? "Approved"
                        : (isCancelled ? "Cancelled" : (latestRequest && latestRequest.status !== 'Approved' ? latestRequest.status : "Not Submitted")),
                    admin_remarks: latestRequest?.admin_remarks || null,
                    requested_at: latestRequest?.requested_at || null
                },
                pass: activePass ? {
                    pass_id: activePass.pass_id,
                    pass_number: activePass.pass_number,
                    valid_to: activePass.valid_to,
                    status: activePass.status
                } : null,
                trip: activeTrip ? {
                    is_on_trip: true,
                    trip_id: activeTrip.trip_id,
                    start_time: activeTrip.start_time
                } : {
                    is_on_trip: false
                }
            });
        } catch (error) {
            console.error("Dashboard summary error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 4. GET MY ROUTE & ORDERED STOPS
    // =========================================================
    router.get("/route", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const transport = await getStudentTransportDetails(studentId);

            if (!transport || !transport.route_id) {
                return res.json({
                    success: true,
                    assigned: false,
                    message: "You have not been assigned a route yet. Please apply for a college bus transportation pass.",
                    route: null,
                    stops: []
                });
            }

            // Retrieve all ordered stops on this route
            const [stops] = await db.query(
                `
                SELECT
                    rs.stop_order,
                    s.stop_id,
                    s.stop_name,
                    s.location,
                    s.distance_km,
                    s.latitude,
                    s.longitude,
                    s.status AS stop_status,
                    COALESCE(f.amount, ?) AS stop_fee
                FROM route_stops rs
                JOIN stops s ON rs.stop_id = s.stop_id
                LEFT JOIN fees f ON f.stop_id = s.stop_id AND f.status = 'Active'
                WHERE rs.route_id = ?
                ORDER BY rs.stop_order ASC
                `,
                [calculateFeeByDistance(transport.distance_km), transport.route_id]
            );

            // Calculate student fee for their selected stop
            const feeInfo = await getStudentFeeInfo(studentId, transport.stop_id, transport.distance_km);

            res.json({
                success: true,
                assigned: true,
                student_stop_id: transport.stop_id,
                student_stop_name: transport.stop_name,
                student_distance_km: Number(transport.distance_km || 0),
                applicable_fee: feeInfo.applicable_fee,
                student_fee: feeInfo.applicable_fee,
                route: {
                    route_id: transport.route_id,
                    route_name: transport.route_name,
                    start_location: transport.start_location,
                    end_location: transport.end_location,
                    status: transport.route_status,
                    student_stop_id: transport.stop_id,
                    student_stop_name: transport.stop_name,
                    student_distance_km: Number(transport.distance_km || 0),
                    student_fee: feeInfo.applicable_fee,
                    applicable_fee: feeInfo.applicable_fee
                },
                stops: stops.map(s => ({
                    order: s.stop_order,
                    stop_id: s.stop_id,
                    stop_name: s.stop_name,
                    location: s.location,
                    distance_km: Number(s.distance_km || 0),
                    latitude: s.latitude ? Number(s.latitude) : null,
                    longitude: s.longitude ? Number(s.longitude) : null,
                    fee: Number(s.stop_fee || calculateFeeByDistance(s.distance_km)),
                    is_student_stop: s.stop_id === transport.stop_id
                }))
            });
        } catch (error) {
            console.error("Fetch student route error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 5. GET AVAILABLE ROUTES & STOPS (FOR PASS REQUEST APPLICATION)
    // =========================================================
    router.get("/available-routes", authStudent, async (req, res) => {
        try {
            const [routes] = await db.query(
                `SELECT route_id, route_name, start_location, end_location FROM routes WHERE status = 'Active' ORDER BY route_name ASC`
            );

            const [stops] = await db.query(
                `
                SELECT
                    rs.route_id,
                    rs.stop_order,
                    s.stop_id,
                    s.stop_name,
                    s.location,
                    s.distance_km,
                    COALESCE(f.amount, 0) AS configured_fee
                FROM route_stops rs
                JOIN stops s ON rs.stop_id = s.stop_id
                LEFT JOIN fees f ON f.stop_id = s.stop_id AND f.status = 'Active'
                WHERE s.status = 'Active'
                ORDER BY rs.route_id ASC, rs.stop_order ASC
                `
            );

            // Group stops under routes
            const routesWithStops = routes.map(r => ({
                ...r,
                stops: stops
                    .filter(s => s.route_id === r.route_id)
                    .map(s => ({
                        stop_id: s.stop_id,
                        stop_name: s.stop_name,
                        distance_km: Number(s.distance_km || 0),
                        fee: Number(s.configured_fee || calculateFeeByDistance(s.distance_km))
                    }))
            }));

            // Check student's recent payment route & stop
            let preferredRouteId = null;
            let preferredStopId = null;
            let paymentAmount = 0;

            const [payRows] = await db.query(
                `SELECT route_id, stop_id, amount
                 FROM payments
                 WHERE student_id = ? AND payment_status = 'Success' AND route_id IS NOT NULL
                 ORDER BY payment_id DESC
                 LIMIT 1`,
                [req.student.student_id]
            );

            if (payRows.length > 0 && payRows[0].route_id) {
                preferredRouteId = payRows[0].route_id;
                preferredStopId = payRows[0].stop_id;
                paymentAmount = Number(payRows[0].amount || 0);
            } else {
                const [transRows] = await db.query(
                    `SELECT route_id, stop_id FROM student_transport WHERE student_id = ? LIMIT 1`,
                    [req.student.student_id]
                );
                if (transRows.length > 0 && transRows[0].route_id) {
                    preferredRouteId = transRows[0].route_id;
                    preferredStopId = transRows[0].stop_id;
                }
            }

            res.json({
                success: true,
                routes: routesWithStops,
                preferred_route_id: preferredRouteId,
                preferred_stop_id: preferredStopId,
                payment_amount: paymentAmount
            });
        } catch (error) {
            console.error("Fetch available routes error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 6. GET DRIVER & BUS DETAILS
    // =========================================================
    router.get("/driver-bus", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const transport = await getStudentTransportDetails(studentId);

            if (!transport || !transport.bus_id) {
                // Check if bus request is pending
                const [reqRows] = await db.query(
                    "SELECT status FROM bus_pass_requests WHERE student_id = ? ORDER BY request_id DESC LIMIT 1",
                    [studentId]
                );
                const reqStatus = reqRows.length > 0 ? reqRows[0].status : null;

                return res.json({
                    success: true,
                    assigned: false,
                    request_status: reqStatus,
                    message: reqStatus === "Pending"
                        ? "Your bus request is currently waiting for administrator approval."
                        : "No bus or driver has been assigned to your transportation profile yet."
                });
            }

            res.json({
                success: true,
                assigned: true,
                bus: {
                    bus_id: transport.bus_id,
                    bus_number: transport.bus_number,
                    bus_name: transport.bus_name,
                    capacity: transport.bus_capacity,
                    status: transport.bus_status,
                    route_name: transport.route_name,
                    boarding_stop: transport.stop_name
                },
                driver: transport.driver_name ? {
                    driver_id: transport.driver_id,
                    name: transport.driver_name,
                    phone_no: transport.driver_phone,
                    email: transport.driver_email,
                    status: transport.driver_status,
                    license_no: transport.driver_license,
                    experience: transport.driver_experience
                } : {
                    name: "Pending Assignment",
                    phone_no: "N/A",
                    status: "Unassigned",
                    experience: null
                }
            });
        } catch (error) {
            console.error("Fetch driver-bus error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 7. GET FEE STATUS & PAYMENT HISTORY
    // =========================================================
    router.get("/fee", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const transport = await getStudentTransportDetails(studentId);

            const stopId = transport?.stop_id || null;
            const distanceKm = transport?.distance_km || 0;
            let feeInfo = await getStudentFeeInfo(studentId, stopId, distanceKm);

            // When route was changed: treat the new route fee as fully outstanding
            // (old payments were for the previous route — don't let them zero-out the new fee)
            const [rcRows] = await db.query(
                "SELECT route_changed FROM student_transport WHERE student_id = ? LIMIT 1",
                [studentId]
            );
            const routeChanged = rcRows.length > 0 && Number(rcRows[0].route_changed) === 1;

            if (routeChanged && feeInfo.applicable_fee > 0) {
                // Show the full new route fee as outstanding regardless of old payments
                feeInfo = {
                    applicable_fee: feeInfo.applicable_fee,
                    amount_paid: 0,          // old payments belong to old route
                    outstanding_amount: feeInfo.applicable_fee,
                    payment_status: "Unpaid"
                };
            }

            // Fetch payment history
            const [payments] = await db.query(
                `
                SELECT
                    p.payment_id AS id,
                    p.payment_id,
                    p.amount,
                    p.transaction_id,
                    p.payment_method,
                    p.payment_status,
                    p.payment_date,
                    p.created_at,
                    r.route_name,
                    sp.stop_name,
                    sp.distance_km
                FROM payments p
                LEFT JOIN routes r ON p.route_id = r.route_id
                LEFT JOIN stops sp ON p.stop_id = sp.stop_id
                WHERE p.student_id = ?
                ORDER BY p.payment_id DESC
                `,
                [studentId]
            );

            res.json({
                success: true,
                route_changed: routeChanged,
                route_name: transport ? transport.route_name : "N/A",
                stop_name: transport ? transport.stop_name : "N/A",
                distance_km: transport ? Number(transport.distance_km || 0) : 0,
                stop: transport ? {
                    stop_id: transport.stop_id,
                    stop_name: transport.stop_name,
                    distance_km: Number(transport.distance_km || 0),
                    route_name: transport.route_name
                } : null,
                route: transport ? {
                    route_id: transport.route_id,
                    route_name: transport.route_name
                } : null,
                fee: feeInfo,
                payments: payments.map(p => ({
                    id: p.payment_id,
                    payment_id: p.payment_id,
                    amount: Number(p.amount || 0),
                    amount_paid: Number(p.amount || 0),
                    transaction_id: p.transaction_id || "N/A",
                    transaction_ref: p.transaction_id || "N/A",
                    reference_no: p.transaction_id || "N/A",
                    payment_method: p.payment_method || "Online UPI",
                    payment_mode: p.payment_method || "Online UPI",
                    method: p.payment_method || "Online UPI",
                    mode: p.payment_method || "Online UPI",
                    payment_status: p.payment_status || "Success",
                    status: p.payment_status || "Success",
                    payment_date: p.payment_date || p.created_at,
                    date: p.payment_date || p.created_at,
                    created_at: p.created_at,
                    receipt_available: true,
                    route_name: p.route_name || transport?.route_name || "N/A",
                    stop_name: p.stop_name || transport?.stop_name || "N/A"
                }))
            });
        } catch (error) {
            console.error("Fetch student fee error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 8. PROCESS FEE PAYMENT (ATOMIC TRANSACTION & VERIFICATION)
    // =========================================================
    router.post("/pay", authStudent, async (req, res) => {
        let connection;
        try {
            const studentId = req.student.student_id;
            const { amount, method, payment_method, upi_id } = req.body;

            // Validate mandatory UPI ID
            const cleanUpiId = String(upi_id || "").trim();
            const upiRegex = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}$/;
            if (!cleanUpiId || !upiRegex.test(cleanUpiId)) {
                return res.status(400).json({
                    success: false,
                    message: "A valid UPI ID is required (format: name@bank or username@upi)."
                });
            }

            const transport = await getStudentTransportDetails(studentId);
            if (!transport || !transport.stop_id) {
                return res.status(400).json({
                    success: false,
                    message: "You must have a selected route and boarding stop before paying fees."
                });
            }

            let feeInfo = await getStudentFeeInfo(studentId, transport.stop_id, transport.distance_km);

            // When route was changed, old payments belong to old route — treat new route fee as fully outstanding
            const [rcPayRows] = await db.query(
                "SELECT route_changed FROM student_transport WHERE student_id = ? LIMIT 1",
                [studentId]
            );
            const isRouteChangedPay = rcPayRows.length > 0 && Number(rcPayRows[0].route_changed) === 1;
            if (isRouteChangedPay && feeInfo.applicable_fee > 0) {
                feeInfo = {
                    applicable_fee: feeInfo.applicable_fee,
                    amount_paid: 0,
                    outstanding_amount: feeInfo.applicable_fee,
                    payment_status: "Unpaid"
                };
            }

            if (feeInfo.outstanding_amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Transportation fee is already fully paid. No outstanding dues."
                });
            }

            const payAmount = Number(amount || feeInfo.outstanding_amount);
            if (!payAmount || payAmount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Please specify a valid payment amount."
                });
            }

            if (payAmount > feeInfo.outstanding_amount) {
                return res.status(400).json({
                    success: false,
                    message: `Payment amount cannot exceed outstanding balance of ₹${feeInfo.outstanding_amount.toLocaleString("en-IN")}.`
                });
            }

            const payMethod = (payment_method || method || "Online UPI").trim();
            const transactionId = `TXN-VEMU-${Date.now().toString().slice(-6)}${Math.floor(100 + Math.random() * 900)}`;

            // Resolve fee_id
            let feeId = null;
            const [feeRow] = await db.query(
                "SELECT fee_id FROM fees WHERE stop_id = ? AND status = 'Active' LIMIT 1",
                [transport.stop_id]
            );
            if (feeRow.length > 0) feeId = feeRow[0].fee_id;

            connection = await db.getConnection();
            await connection.beginTransaction();

            const [payResult] = await connection.execute(
                `
                INSERT INTO payments (
                    student_id, fee_id, amount, transaction_id, payment_status,
                    payment_date, route_id, stop_id, bus_id, payment_method, upi_id
                ) VALUES (?, ?, ?, ?, 'Success', NOW(), ?, ?, ?, ?, ?)
                `,
                [
                    studentId,
                    feeId,
                    payAmount,
                    transactionId,
                    transport.route_id,
                    transport.stop_id,
                    transport.bus_id || null,
                    payMethod,
                    cleanUpiId
                ]
            );

            const paymentId = payResult.insertId;

            await connection.commit();

            // -------------------------------------------------------
            // 1C: AUTO-GENERATE BUS PASS when route was changed
            // -------------------------------------------------------
            let autoPass = null;
            try {
                // Check if this student has route_changed = 1
                const [changedRows] = await db.query(
                    "SELECT route_changed FROM student_transport WHERE student_id = ? LIMIT 1",
                    [studentId]
                );
                const isRouteChanged = changedRows.length > 0 && Number(changedRows[0].route_changed) === 1;

                if (isRouteChanged) {
                    // Idempotency: check if a pass was already generated for this payment
                    const [dupCheck] = await db.query(
                        "SELECT pass_id, pass_number FROM bus_passes WHERE payment_id = ? LIMIT 1",
                        [paymentId]
                    );

                    if (dupCheck.length === 0) {
                        // Fetch student info needed for pass
                        const [stuRows] = await db.query(
                            "SELECT name, roll_no, branch FROM students WHERE student_id = ? LIMIT 1",
                            [studentId]
                        );
                        const stuInfo = stuRows[0] || {};

                        // Mark old Active pass as Replaced (additive status — does not delete)
                        await db.execute(
                            "UPDATE bus_passes SET status = 'Replaced' WHERE student_id = ? AND status = 'Active'",
                            [studentId]
                        );

                        // Generate new pass number
                        const passNumber = `CG-RC-${studentId}-${paymentId}`;
                        const qrData = `CAMPUSGO:PASS:${passNumber}:STUDENT:${studentId}:ROLL:${stuInfo.roll_no || ""}`;

                        const [passResult] = await db.execute(
                            `INSERT INTO bus_passes
                                (student_id, roll_no, stop_name, route_name, bus_number, amount_paid,
                                 pass_number, issue_date, valid_from, valid_to, status,
                                 payment_id, route_id, bus_id, stop_id, qr_data)
                             VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), CURDATE(),
                                     DATE_ADD(CURDATE(), INTERVAL 1 YEAR), 'Active',
                                     ?, ?, ?, ?, ?)`,
                            [
                                studentId,
                                stuInfo.roll_no || "",
                                transport.stop_name || "Designated Stop",
                                transport.route_name || "Campus Route",
                                transport.bus_number || "BUS-CAMPUS",
                                payAmount,
                                passNumber,
                                paymentId,
                                transport.route_id || null,
                                transport.bus_id || null,
                                transport.stop_id || null,
                                qrData
                            ]
                        );
                        autoPass = { pass_id: passResult.insertId, pass_number: passNumber };

                        // Reset route_changed flag so pass is not re-generated on another payment
                        await db.execute(
                            "UPDATE student_transport SET route_changed = 0 WHERE student_id = ?",
                            [studentId]
                        );
                    } else {
                        // Pass already generated for this payment (duplicate click protection)
                        autoPass = { pass_id: dupCheck[0].pass_id, pass_number: dupCheck[0].pass_number };
                    }
                }
            } catch (passErr) {
                // Pass generation failure must NOT fail the payment itself
                console.error("Auto pass generation error (payment succeeded):", passErr);
            }

            // Real-time synchronization
            await broadcastStatistics();
            io.emit("paymentsUpdated");
            io.emit("feesUpdated");
            io.emit("studentFeePaid", {
                student_id: studentId,
                payment_id: paymentId,
                amount: payAmount
            });
            if (autoPass) {
                io.emit("busPassesUpdated");
                io.emit("studentTransportUpdated", { student_id: studentId });
            }

            res.status(201).json({
                success: true,
                message: autoPass
                    ? "Fee payment successful! Bus pass for the new route has been generated automatically."
                    : "Fee payment successful! Official receipt generated.",
                receipt_id: paymentId,
                auto_pass_generated: Boolean(autoPass),
                pass: autoPass || null,
                payment: {
                    payment_id: paymentId,
                    id: paymentId,
                    amount: payAmount,
                    upi_id: cleanUpiId,
                    transaction_id: transactionId,
                    method: payMethod,
                    status: "Success",
                    date: new Date().toISOString()
                }
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Student payment error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // =========================================================
    // 9. GET PAYMENT RECEIPTS LIST & SINGLE RECEIPT
    // =========================================================
    router.get("/receipts", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const [receipts] = await db.query(
                `
                SELECT
                    p.payment_id AS id,
                    p.payment_id,
                    p.amount,
                    p.transaction_id,
                    p.payment_method,
                    p.payment_status,
                    p.payment_date,
                    p.created_at,
                    p.upi_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.phone_no,
                    r.route_name,
                    sp.stop_name,
                    sp.distance_km,
                    COALESCE(f.amount, p.amount) AS applicable_fee
                FROM payments p
                JOIN students s ON p.student_id = s.student_id
                LEFT JOIN routes r ON p.route_id = r.route_id
                LEFT JOIN stops sp ON p.stop_id = sp.stop_id
                LEFT JOIN fees f ON p.fee_id = f.fee_id
                WHERE p.student_id = ? AND p.payment_status = 'Success'
                ORDER BY p.payment_id DESC
                `,
                [studentId]
            );

            res.json({
                success: true,
                total: receipts.length,
                receipts: receipts.map(p => ({
                    id: p.payment_id,
                    payment_id: p.payment_id,
                    receipt_number: `RCP-PAY-${String(p.payment_id).padStart(6, '0')}`,
                    student_name: p.student_name,
                    roll_no: p.roll_no,
                    branch: p.branch,
                    phone: p.phone_no,
                    route_name: p.route_name || "N/A",
                    stop_name: p.stop_name || "N/A",
                    distance_km: Number(p.distance_km || 0),
                    applicable_fee: Number(p.applicable_fee || p.amount),
                    amount: Number(p.amount || 0),
                    amount_paid: Number(p.amount || 0),
                    transaction_id: p.transaction_id || "N/A",
                    transaction_ref: p.transaction_id || "N/A",
                    reference_no: p.transaction_id || "N/A",
                    upi_id: p.upi_id || "N/A",
                    payment_method: p.payment_method || "Online UPI",
                    payment_mode: p.payment_method || "Online UPI",
                    method: p.payment_method || "Online UPI",
                    mode: p.payment_method || "Online UPI",
                    payment_status: p.payment_status || "Success",
                    status: p.payment_status || "Success",
                    payment_date: p.payment_date || p.created_at,
                    date: p.payment_date || p.created_at,
                    created_at: p.created_at
                }))
            });
        } catch (error) {
            console.error("Fetch student receipts error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/receipts/:id", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const paymentId = Number(req.params.id);

            const [rows] = await db.query(
                `
                SELECT
                    p.payment_id AS id,
                    p.payment_id,
                    p.amount,
                    p.transaction_id,
                    p.payment_method,
                    p.payment_status,
                    p.payment_date,
                    p.created_at,
                    p.upi_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.phone_no,
                    r.route_name,
                    sp.stop_name,
                    sp.distance_km,
                    COALESCE(f.amount, p.amount) AS applicable_fee
                FROM payments p
                JOIN students s ON p.student_id = s.student_id
                LEFT JOIN routes r ON p.route_id = r.route_id
                LEFT JOIN stops sp ON p.stop_id = sp.stop_id
                LEFT JOIN fees f ON p.fee_id = f.fee_id
                WHERE p.payment_id = ? AND p.student_id = ?
                `,
                [paymentId, studentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ success: false, message: "Receipt record not found." });
            }

            const p = rows[0];
            res.json({
                success: true,
                receipt: {
                    id: p.payment_id,
                    payment_id: p.payment_id,
                    receipt_number: `RCP-PAY-${String(p.payment_id).padStart(6, '0')}`,
                    student_name: p.student_name,
                    roll_no: p.roll_no,
                    branch: p.branch,
                    phone: p.phone_no,
                    route_name: p.route_name || "N/A",
                    stop_name: p.stop_name || "N/A",
                    distance_km: Number(p.distance_km || 0),
                    applicable_fee: Number(p.applicable_fee || p.amount),
                    amount: Number(p.amount || 0),
                    amount_paid: Number(p.amount || 0),
                    transaction_id: p.transaction_id || "N/A",
                    transaction_ref: p.transaction_id || "N/A",
                    reference_no: p.transaction_id || "N/A",
                    upi_id: p.upi_id || "N/A",
                    payment_method: p.payment_method || "Online UPI",
                    payment_mode: p.payment_method || "Online UPI",
                    method: p.payment_method || "Online UPI",
                    mode: p.payment_method || "Online UPI",
                    payment_status: p.payment_status || "Success",
                    status: p.payment_status || "Success",
                    payment_date: p.payment_date || p.created_at,
                    date: p.payment_date || p.created_at,
                    created_at: p.created_at
                }
            });
        } catch (error) {
            console.error("Fetch single receipt error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 10. GET BUS PASS / BUS REQUEST STATUS
    // =========================================================
    router.get("/bus-request", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const transport = await getStudentTransportDetails(studentId);

            // Latest pass request
            const [reqRows] = await db.query(
                `
                SELECT
                    bpr.request_id,
                    bpr.status,
                    bpr.admin_remarks,
                    bpr.passport_photo,
                    bpr.requested_at,
                    bpr.reviewed_at,
                    r.route_name,
                    sp.stop_name
                FROM bus_pass_requests bpr
                LEFT JOIN routes r ON bpr.route_id = r.route_id
                LEFT JOIN stops sp ON bpr.stop_id = sp.stop_id
                WHERE bpr.student_id = ?
                ORDER BY bpr.request_id DESC
                LIMIT 1
                `,
                [studentId]
            );

            // Check route_changed flag — when 1, suppress old active pass
            const [rcRows] = await db.query(
                "SELECT route_changed FROM student_transport WHERE student_id = ? LIMIT 1",
                [studentId]
            );
            const routeChangedFlag = rcRows.length > 0 && Number(rcRows[0].route_changed) === 1;

            // Latest generated active pass (suppressed when route was changed but fee not yet paid)
            const [passRows] = await db.query(
                `
                SELECT
                    bp.pass_id,
                    bp.pass_number,
                    bp.student_id,
                    bp.roll_no,
                    bp.stop_name,
                    bp.route_name,
                    bp.bus_number,
                    bp.amount_paid,
                    bp.issue_date,
                    bp.valid_from,
                    bp.valid_to,
                    bp.status,
                    bp.qr_data,
                    COALESCE(bpr.passport_photo, (SELECT passport_photo FROM bus_pass_requests WHERE student_id = bp.student_id AND passport_photo IS NOT NULL ORDER BY request_id DESC LIMIT 1)) AS passport_photo
                FROM bus_passes bp
                LEFT JOIN bus_pass_requests bpr ON bp.request_id = bpr.request_id
                WHERE bp.student_id = ? AND bp.status = 'Active'
                ORDER BY bp.pass_id DESC
                LIMIT 1
                `,
                [studentId]
            );

            // Suppress old pass if route changed and fee not yet paid
            const activePass = (!routeChangedFlag && passRows.length > 0) ? passRows[0] : null;
            const rawReq = reqRows.length > 0 ? reqRows[0] : null;
            // If pass was deleted or revoked by admin, do not present an orphaned 'Approved' request
            const latestReq = (!activePass && rawReq && rawReq.status === 'Approved') ? null : rawReq;

            // Fee info needed for route-changed banner message
            const stopId = transport?.stop_id || null;
            const distKm  = transport?.distance_km || 0;
            const feeInfo = routeChangedFlag
                ? await (async () => {
                    const fi = await getStudentFeeInfo(studentId, stopId, distKm);
                    return { applicable_fee: fi.applicable_fee, outstanding_amount: fi.applicable_fee, payment_status: "Unpaid" };
                })()
                : null;

            res.json({
                success: true,
                route_changed: routeChangedFlag,
                student: req.student,
                transport,
                fee: feeInfo,
                request: latestReq ? {
                    ...latestReq,
                    passport_photo: latestReq.passport_photo || null
                } : null,
                pass: activePass ? {
                    ...activePass,
                    student_name: req.student.name,
                    branch: req.student.branch,
                    passport_photo: activePass.passport_photo || (rawReq && rawReq.passport_photo) || null
                } : null
            });
        } catch (error) {
            console.error("Fetch bus request error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 11. SUBMIT BUS PASS REQUEST
    // =========================================================
    router.post("/bus-request", authStudent, handlePassportUpload, async (req, res) => {
        let connection;
        try {
            const studentId = req.student.student_id;
            const { route_id, stop_id, remarks } = req.body;

            const routeId = Number(route_id);
            const stopId = Number(stop_id);

            // CHANGE 1: Validate passport photo upload
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Passport size photo is required."
                });
            }

            if (!Number.isInteger(routeId) || routeId <= 0 || !Number.isInteger(stopId) || stopId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Please select both a valid college route and boarding stop."
                });
            }

            // Check if there's already an active pass or a pending request
            const [pending] = await db.query(
                "SELECT request_id FROM bus_pass_requests WHERE student_id = ? AND status = 'Pending' LIMIT 1",
                [studentId]
            );

            if (pending.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: "You already have a bus pass request waiting for administrator approval."
                });
            }

            connection = await db.getConnection();
            await connection.beginTransaction();

            // Find recent payment for this student if any
            const [payRows] = await connection.query(
                "SELECT payment_id FROM payments WHERE student_id = ? ORDER BY payment_id DESC LIMIT 1",
                [studentId]
            );
            const paymentId = payRows.length > 0 ? payRows[0].payment_id : null;

            const passportPhotoPath = `/uploads/passport-photos/${req.file.filename}`;

            // Insert new request with passport_photo
            const [reqResult] = await connection.execute(
                `
                INSERT INTO bus_pass_requests (student_id, payment_id, route_id, stop_id, status, admin_remarks, passport_photo, requested_at)
                VALUES (?, ?, ?, ?, 'Pending', ?, ?, NOW())
                `,
                [studentId, paymentId, routeId, stopId, remarks || "Student applied via Portal", passportPhotoPath]
            );

            // Update student_transport to mark selected route & stop with Pending status
            const [existingTransport] = await connection.query(
                "SELECT transport_id FROM student_transport WHERE student_id = ? LIMIT 1",
                [studentId]
            );

            if (existingTransport.length > 0) {
                await connection.execute(
                    "UPDATE student_transport SET route_id = ?, stop_id = ?, status = 'Pending' WHERE student_id = ?",
                    [routeId, stopId, studentId]
                );
            } else {
                await connection.execute(
                    "INSERT INTO student_transport (student_id, route_id, stop_id, status) VALUES (?, ?, ?, 'Pending')",
                    [studentId, routeId, stopId]
                );
            }

            await connection.commit();

            // Real-time synchronization with Admin Dashboard
            await broadcastStatistics();
            io.emit("passRequestsUpdated");

            res.status(201).json({
                success: true,
                message: "Bus pass application submitted successfully! It is now waiting for administrator approval.",
                request_id: reqResult.insertId
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Submit bus request error:", error);
            res.status(500).json({ success: false, message: error.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // =========================================================
    // 12. LIVE BUS TRACKING (STRICTLY SCOPED TO STUDENT'S ASSIGNED BUS)
    // =========================================================
    router.get("/live-tracking", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;

            // CHANGE 4: Gating - cancelled pass profiles cannot receive live tracking (backend 403 enforcement)
            const isCancelled = await isStudentPassCancelled(db, studentId);
            if (isCancelled) {
                return res.status(403).json({
                    success: false,
                    is_inactive: true,
                    message: "Live tracking is unavailable because your bus pass is cancelled."
                });
            }

            const transport = await getStudentTransportDetails(studentId);

            if (!transport || !transport.bus_id) {
                return res.json({
                    success: true,
                    assigned: false,
                    is_unassigned: true,
                    message: "Live tracking is only available once an administrator has assigned a bus to your route.",
                    tracking: null
                });
            }

            const busId = transport.bus_id;

            // Check if there is an active trip in progress
            const [trips] = await db.query(
                `
                SELECT trip_id, bus_id, driver_id, route_id, start_time, status
                FROM trips
                WHERE bus_id = ? AND status = 'Started'
                ORDER BY trip_id DESC
                LIMIT 1
                `,
                [busId]
            );

            const activeTrip = trips.length > 0 ? trips[0] : null;

            // Latest GPS location for this bus
            const [locations] = await db.query(
                `
                SELECT location_id, trip_id, bus_id, latitude, longitude, speed, heading, recorded_at
                FROM live_locations
                WHERE bus_id = ?
                ORDER BY location_id DESC
                LIMIT 1
                `,
                [busId]
            );

            const latestLoc = locations.length > 0 ? locations[0] : null;

            // Ordered route stops
            const [stops] = await db.query(
                `
                SELECT
                    rs.stop_order,
                    s.stop_id,
                    s.stop_name,
                    s.latitude,
                    s.longitude,
                    s.distance_km,
                    tsp.status AS progress_status,
                    tsp.updated_at AS stop_reached_time
                FROM route_stops rs
                JOIN stops s ON rs.stop_id = s.stop_id
                LEFT JOIN trip_stop_progress tsp ON tsp.stop_id = s.stop_id AND tsp.trip_id = ?
                WHERE rs.route_id = ?
                ORDER BY rs.stop_order ASC
                `,
                [activeTrip ? activeTrip.trip_id : 0, transport.route_id]
            );

            // Determine if GPS location is fresh or stale (> 3 minutes ago)
            let isStale = false;
            if (latestLoc && latestLoc.recorded_at) {
                const diffMs = Date.now() - new Date(latestLoc.recorded_at).getTime();
                if (diffMs > 3 * 60 * 1000) {
                    isStale = true;
                }
            }

            const formattedStops = stops.map(s => ({
                order: s.stop_order,
                stop_id: s.stop_id,
                stop_name: s.stop_name,
                latitude: s.latitude ? Number(s.latitude) : null,
                longitude: s.longitude ? Number(s.longitude) : null,
                progress: s.progress_status || "upcoming",
                is_student_stop: s.stop_id === transport.stop_id
            }));

            res.json({
                success: true,
                assigned: true,
                is_unassigned: false,
                bus_number: transport.bus_number,
                driver_name: transport.driver_name || "Assigned Driver",
                driver_phone: transport.driver_phone || "N/A",
                is_on_trip: Boolean(activeTrip),
                route_stops: formattedStops,
                bus: {
                    bus_id: transport.bus_id,
                    bus_number: transport.bus_number,
                    bus_name: transport.bus_name,
                    driver_name: transport.driver_name || "Assigned Driver",
                    driver_phone: transport.driver_phone || "N/A"
                },
                trip: activeTrip ? {
                    trip_id: activeTrip.trip_id,
                    status: "Started",
                    start_time: activeTrip.start_time
                } : {
                    status: "Not Started"
                },
                location: latestLoc ? {
                    latitude: Number(latestLoc.latitude),
                    longitude: Number(latestLoc.longitude),
                    speed: Number(latestLoc.speed || 0),
                    heading: Number(latestLoc.heading || 0),
                    recorded_at: latestLoc.recorded_at,
                    is_stale: isStale
                } : null,
                route: {
                    route_id: transport.route_id,
                    route_name: transport.route_name,
                    student_stop_id: transport.stop_id,
                    student_stop_name: transport.stop_name
                },
                stops: formattedStops
            });
        } catch (error) {
            console.error("Fetch live tracking error:", error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // =========================================================
    // 13. TRANSPORTATION & BUS PASS CANCELLATIONS
    // =========================================================
    router.get("/cancellations", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;

            // Fetch current active pass
            const [passRows] = await db.query(
                `SELECT pass_id, pass_number, stop_name, route_name, bus_number, amount_paid, valid_from, valid_to, status
                 FROM bus_passes
                 WHERE student_id = ? AND status = 'Active'
                 ORDER BY pass_id DESC LIMIT 1`,
                [studentId]
            );

            // Fetch current transport assignment
            const transport = await getStudentTransportDetails(studentId);

            // Fetch pending request if any
            const [pendingRows] = await db.query(
                `SELECT cancellation_id, reason, status, fine_amount, fine_payment_status, fine_paid_at, fine_transaction_id, admin_remarks, requested_at, reviewed_at
                 FROM transport_cancellations
                 WHERE student_id = ? AND status = 'Pending'
                 ORDER BY cancellation_id DESC LIMIT 1`,
                [studentId]
            );

            // Fetch all past cancellation requests
            const [historyRows] = await db.query(
                `SELECT cancellation_id, pass_id, reason, status, fine_amount, fine_payment_status, fine_paid_at, fine_transaction_id, admin_remarks, requested_at, reviewed_at
                 FROM transport_cancellations
                 WHERE student_id = ?
                 ORDER BY cancellation_id DESC`,
                [studentId]
            );

            res.json({
                success: true,
                student: req.student,
                active_pass: passRows.length > 0 ? passRows[0] : null,
                active_transport: transport,
                pending_request: pendingRows.length > 0 ? pendingRows[0] : null,
                cancellations: historyRows
            });
        } catch (error) {
            console.error("Fetch cancellations error:", error);
            res.status(500).json({ success: false, message: "Unable to load cancellation details." });
        }
    });

    router.post("/cancellations", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const { reason } = req.body;

            const cleanReason = String(reason || "").trim();
            if (!cleanReason || cleanReason.length < 5) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid cancellation reason (at least 5 characters)."
                });
            }

            // Check if student already has a pending request
            const [pending] = await db.query(
                "SELECT cancellation_id FROM transport_cancellations WHERE student_id = ? AND status = 'Pending' LIMIT 1",
                [studentId]
            );

            if (pending.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: "You already have a pending cancellation request under review."
                });
            }

            // Check active transport or pass
            const [transports] = await db.query(
                "SELECT transport_id, status FROM student_transport WHERE student_id = ? AND status = 'Active' ORDER BY transport_id DESC LIMIT 1",
                [studentId]
            );

            const [passes] = await db.query(
                "SELECT pass_id, status FROM bus_passes WHERE student_id = ? AND status = 'Active' ORDER BY pass_id DESC LIMIT 1",
                [studentId]
            );

            if (transports.length === 0 && passes.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "You do not have an active bus pass or active transportation assignment to cancel."
                });
            }

            const transportId = transports.length > 0 ? transports[0].transport_id : null;
            const passId = passes.length > 0 ? passes[0].pass_id : null;

            const [result] = await db.execute(
                `INSERT INTO transport_cancellations (student_id, student_transport_id, pass_id, reason, status, requested_at)
                 VALUES (?, ?, ?, ?, 'Pending', NOW())`,
                [studentId, transportId, passId, cleanReason]
            );

            const cancellationId = result.insertId;

            // Notify Admin via Socket.IO
            io.emit("cancellationRequested", {
                cancellation_id: cancellationId,
                student_id: studentId,
                student_name: req.student.name,
                roll_no: req.student.roll_no,
                reason: cleanReason,
                requested_at: new Date().toISOString()
            });

            // Also create an Admin notification record in MySQL
            await db.execute(
                `INSERT INTO notifications (user_role, user_id, title, message, type, sender_role, sender_id, created_at)
                 VALUES ('admin', 1, 'New Bus Pass Cancellation Request', ?, 'CANCELLATION', 'student', ?, NOW())`,
                [`${req.student.name} (${req.student.roll_no}) requested transportation cancellation. Reason: ${cleanReason}`, studentId]
            ).catch(e => console.warn("Admin notification creation skipped:", e.message));

            res.status(201).json({
                success: true,
                message: "Transportation cancellation request submitted successfully for Admin review.",
                cancellation_id: cancellationId
            });
        } catch (error) {
            console.error("Submit cancellation error:", error);
            res.status(500).json({ success: false, message: "Unable to submit cancellation request." });
        }
    });

    router.post("/cancellations/:id/pay-fine", authStudent, async (req, res) => {
        let connection;
        try {
            const studentId = req.student.student_id;
            const cancellationId = Number(req.params.id);
            const { upi_id } = req.body;

            // Validate mandatory UPI ID
            const cleanUpiId = String(upi_id || "").trim();
            const upiRegex = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}$/;
            if (!cleanUpiId || !upiRegex.test(cleanUpiId)) {
                return res.status(400).json({
                    success: false,
                    message: "A valid UPI ID is required (format: name@bank or username@upi)."
                });
            }

            // Check cancellation request
            const [rows] = await db.query(
                "SELECT cancellation_id, student_id, status, fine_amount, fine_payment_status FROM transport_cancellations WHERE cancellation_id = ?",
                [cancellationId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ success: false, message: "Cancellation request not found." });
            }

            const record = rows[0];
            if (record.student_id !== studentId) {
                return res.status(403).json({ success: false, message: "Unauthorized access to this cancellation record." });
            }

            if (record.status !== "Approved") {
                return res.status(400).json({ success: false, message: "Cancellation request is not approved yet." });
            }

            const fineAmount = Number(record.fine_amount || 0);
            if (fineAmount <= 0) {
                return res.status(400).json({ success: false, message: "No cancellation fine is due for this request." });
            }

            if (record.fine_payment_status === "Paid") {
                return res.status(400).json({ success: false, message: "Cancellation fee has already been paid." });
            }

            const transactionId = `TXN-FINE-${Date.now().toString().slice(-6)}${Math.floor(100 + Math.random() * 900)}`;

            connection = await db.getConnection();
            await connection.beginTransaction();

            // Update transport_cancellations table
            await connection.execute(
                `UPDATE transport_cancellations
                 SET fine_payment_status = 'Paid', fine_paid_at = NOW(), fine_transaction_id = ?
                 WHERE cancellation_id = ? AND (fine_payment_status != 'Paid' OR fine_payment_status IS NULL)`,
                [transactionId, cancellationId]
            );

            // Record into payments table for audit & accounting
            await connection.execute(
                `INSERT INTO payments (
                    student_id, fee_id, amount, transaction_id, payment_status,
                    payment_date, payment_method, upi_id
                ) VALUES (?, NULL, ?, ?, 'Success', NOW(), 'Online UPI - Cancellation Fee', ?)`,
                [studentId, fineAmount, transactionId, cleanUpiId]
            );

            await connection.commit();

            // Real-time synchronization
            if (typeof broadcastStatistics === "function") {
                await broadcastStatistics();
            }
            io.emit("paymentsUpdated");
            io.emit("cancellationUpdated", {
                cancellation_id: cancellationId,
                student_id: studentId,
                status: "Approved",
                fine_amount: fineAmount,
                fine_payment_status: "Paid",
                fine_transaction_id: transactionId
            });

            res.json({
                success: true,
                message: "Cancellation fee paid successfully! Status updated to Paid.",
                payment: {
                    cancellation_id: cancellationId,
                    amount: fineAmount,
                    upi_id: cleanUpiId,
                    transaction_id: transactionId,
                    fine_payment_status: "Paid",
                    date: new Date().toISOString()
                }
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Pay cancellation fine error:", error);
            res.status(500).json({ success: false, message: error.message || "Failed to process cancellation fee payment." });
        } finally {
            if (connection) connection.release();
        }
    });

    // =========================================================
    // 14. STUDENT NOTIFICATIONS
    // =========================================================
    router.get("/notifications", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            const transport = await getStudentTransportDetails(studentId);
            const isTransportActive = transport && transport.transport_status === 'Active';

            // Check if student has an approved cancellation or cancelled transport
            const [cancellations] = await db.query(
                "SELECT cancellation_id FROM transport_cancellations WHERE student_id = ? AND status = 'Approved' LIMIT 1",
                [studentId]
            );
            const hasCancelledBooking = cancellations.length > 0 || (transport && transport.transport_status === 'Cancelled');

            const busId = (isTransportActive && !hasCancelledBooking && transport) ? transport.bus_id : null;
            const routeId = (isTransportActive && !hasCancelledBooking && transport) ? transport.route_id : null;

            let query = `
                SELECT
                    notification_id,
                    title,
                    message,
                    type,
                    sender_role,
                    bus_id,
                    route_id,
                    is_public,
                    is_read,
                    created_at
                FROM notifications
                WHERE (
                    (user_role = 'student' AND (user_id = ? OR user_id = 0))
                    ${busId ? "OR (user_role = 'student' AND bus_id = ?)" : ""}
                    ${routeId ? "OR (user_role = 'student' AND route_id = ?)" : ""}
                )
            `;

            const params = [studentId, ...(busId ? [busId] : []), ...(routeId ? [routeId] : [])];

            // If student cancelled their booking, hide all bus/driver specific alerts
            if (hasCancelledBooking) {
                query += " AND (sender_role != 'driver' AND bus_id IS NULL AND route_id IS NULL) ";
            }

            query += " ORDER BY created_at DESC LIMIT 50";

            const [notifications] = await db.query(query, params);

            const unreadCount = notifications.filter(n => !n.is_read).length;

            res.json({
                success: true,
                notifications,
                unread_count: unreadCount,
                has_cancelled_booking: hasCancelledBooking
            });
        } catch (error) {
            console.error("Fetch student notifications error:", error);
            res.status(500).json({ success: false, message: "Unable to load notifications." });
        }
    });

    router.patch("/notifications/:id/read", authStudent, async (req, res) => {
        try {
            const notifId = Number(req.params.id);
            await db.execute("UPDATE notifications SET is_read = 1 WHERE notification_id = ?", [notifId]);
            res.json({ success: true, message: "Notification marked as read." });
        } catch (error) {
            console.error("Mark notification read error:", error);
            res.status(500).json({ success: false, message: "Unable to update notification." });
        }
    });

    router.patch("/notifications/read-all", authStudent, async (req, res) => {
        try {
            const studentId = req.student.student_id;
            await db.execute(
                "UPDATE notifications SET is_read = 1 WHERE user_role = 'student' AND (user_id = ? OR user_id = 0)",
                [studentId]
            );
            res.json({ success: true, message: "All notifications marked as read." });
        } catch (error) {
            console.error("Mark all notifications read error:", error);
            res.status(500).json({ success: false, message: "Unable to update notifications." });
        }
    });

    // =========================================================
    // 15. LOGOUT CONFIRMATION
    // =========================================================
    router.post("/logout", authStudent, (req, res) => {
        res.json({
            success: true,
            message: "Student logged out successfully."
        });
    });

    app.use("/api/student", router);
}

module.exports = { registerStudentRoutes };
