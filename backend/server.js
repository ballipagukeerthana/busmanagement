const path = require("path");
const fs = require("fs");
const multer = require("multer");
require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const http = require("http");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");
const { registerAdminRoutes } = require("./admin-routes");
const { registerDriverRoutes } = require("./driver-routes");
const { registerStudentRoutes } = require("./student-routes");

const UPLOADS_DIR = path.join(__dirname, "uploads");
const PASSPORT_PHOTOS_DIR = path.join(UPLOADS_DIR, "passport-photos");
const LICENSES_DIR = path.join(UPLOADS_DIR, "licenses");
fs.mkdirSync(PASSPORT_PHOTOS_DIR, { recursive: true });
fs.mkdirSync(LICENSES_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// ========================================
// MIDDLEWARE
// ========================================
app.use(cors());
app.use(express.json());
// Gracefully handle malformed JSON payloads from clients
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({ success: false, message: "Invalid JSON payload in request body." });
    }
    next(err);
});
app.use(express.static(path.join(__dirname, "../frontend")));

// CHANGE 2: Serve licence photos only to the logged-in admin
app.use("/uploads/licenses", (req, res, next) => {
    const roleHeader = req.headers["x-admin-role"] || req.headers["x-role"] || req.headers["role"];
    const referer = req.headers["referer"] || req.headers["referrer"] || "";
    const roleQuery = req.query.role;
    const isAdmin = roleHeader === "admin" || roleQuery === "admin" || referer.includes("admin-dashboard.html") || referer.includes("/admin");
    if (!isAdmin) {
        return res.status(403).json({
            success: false,
            message: "Access denied. Licence photos are only accessible by administrators."
        });
    }
    next();
});

// CHANGE 1: Serve /uploads as static files with express.static
app.use("/uploads", express.static(UPLOADS_DIR));

// Driver license multer storage configuration
const licenseStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, LICENSES_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeBase = `license-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${safeBase}${ext}`);
    }
});

const uploadLicense = multer({
    storage: licenseStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    fileFilter: (req, file, cb) => {
        const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".pdf"];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext) || file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
            cb(null, true);
        } else {
            cb(new Error("Invalid file format. Allowed formats: JPG, JPEG, PNG, WEBP, GIF, BMP, HEIC, PDF."));
        }
    }
});

function handleLicenseUpload(req, res, next) {
    uploadLicense.single("license_photo")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ success: false, message: "Licence photo exceeds the 5 MB size limit." });
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

// ========================================
// SOCKET.IO
// ========================================
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ========================================
// MYSQL CONNECTION
// Uses the existing CampusGo database
// ========================================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "campusgo",
    port: Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ========================================
// DASHBOARD STATISTICS
// Existing statistics + pending driver requests
// ========================================
async function getStatistics() {
    const [
        [buses],
        [routes],
        [students],
        [allStudents],
        [drivers],
        [stops],
        [pendingRequests],
        [pendingDriverRequests],
        [approvedRequests],
        [pendingPayments],
        [successfulPayments],
        [completedTrips],
        [startedTrips],
        [activeBuses],
        [activeDrivers],
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
        db.query("SELECT COUNT(*) AS total FROM drivers WHERE status = 'Active'"),
        db.query("SELECT COUNT(*) AS total FROM buses WHERE status IN ('Active', 'Available')"),
        db.query("SELECT COUNT(*) AS total FROM buses WHERE status NOT IN ('Active', 'Available')"),
        db.query("SELECT COUNT(*) AS total FROM buses WHERE status IN ('Active', 'Available') AND bus_id NOT IN (SELECT bus_id FROM trips WHERE status = 'Started')"),
        db.query("SELECT COUNT(*) AS total FROM bus_passes"),
        db.query("SELECT COUNT(*) AS total FROM contact_messages WHERE is_read = 0").catch(() => [[{ total: 0 }]])
    ]);

    return {
        // Core counts
        totalBuses: Number(buses[0].total),
        totalRoutes: Number(routes[0].total),
        totalStudents: Number(students[0].total),
        totalAllStudents: Number(allStudents[0].total),
        totalDrivers: Number(drivers[0].total),
        totalStops: Number(stops[0].total),

        // Bus pass requests & generated passes
        pendingRequests: Number(pendingRequests[0].total),
        pendingPassRequests: Number(pendingRequests[0].total),
        approvedRequests: Number(approvedRequests[0].total),
        totalGeneratedPasses: Number(totalPasses[0].total),

        // Driver requests & approvals
        pendingDriverRequests: Number(pendingDriverRequests[0].total),

        // Payments & trips
        pendingPayments: Number(pendingPayments[0].total),
        successfulPayments: Number(successfulPayments[0].total),
        completedTrips: Number(completedTrips[0].total),
        startedTrips: Number(startedTrips[0].total),

        // Bus fleet breakdown
        activeBuses: Number(activeBuses[0].total),
        workingBuses: Number(workingBuses[0].total),
        notWorkingBuses: Number(notWorkingBuses[0].total),
        availableBuses: Number(availableBuses[0].total),
        activeDrivers: Number(activeDrivers[0].total),
        unreadContactMessages: Number((unreadMessages && unreadMessages[0] && unreadMessages[0].total) || 0)
    };
}

// ========================================
// BROADCAST UPDATED STATISTICS
// ========================================
async function broadcastStatistics() {
    try {
        const stats = await getStatistics();

        io.emit("statsUpdated", {
            success: true,
            ...stats
        });

        return stats;
    } catch (error) {
        console.error(
            "Statistics broadcast error:",
            error.message
        );

        throw error;
    }
}

// ========================================
// HOME API
// ========================================
app.get("/", (req, res) => {
    res.send("CampusGo Backend is Running!");
});

// ========================================
// PUBLIC TRANSIT ANNOUNCEMENTS API
// ========================================
app.get("/api/public/announcements", async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT notification_id, title, message, type, created_at 
             FROM notifications 
             WHERE is_public = 1 OR (user_role = 'student' AND user_id = 0 AND sender_role = 'admin')
             ORDER BY created_at DESC 
             LIMIT 10`
        );
        res.json({
            success: true,
            announcements: rows
        });
    } catch (error) {
        console.error("Fetch public announcements error:", error.message);
        res.status(500).json({
            success: false,
            message: "Unable to load public transit announcements.",
            announcements: []
        });
    }
});

// ========================================
// DATABASE CONNECTION TEST
// ========================================
app.get("/api/db-test", async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT DATABASE() AS databaseName"
        );

        res.json({
            success: true,
            message: "CampusGo database connected successfully!",
            database: rows[0].databaseName
        });
    } catch (error) {
        console.error("Database error:", error.message);

        res.status(500).json({
            success: false,
            message: "Database connection failed."
        });
    }
});

// ========================================
// STATISTICS API
// ========================================
app.get("/api/stats", async (req, res) => {
    try {
        const stats = await getStatistics();

        res.json({
            success: true,
            ...stats
        });
    } catch (error) {
        console.error("Statistics error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to load statistics."
        });
    }
});

// ========================================
// MANUAL STATISTICS REFRESH
// ========================================
app.post("/api/stats/refresh", async (req, res) => {
    try {
        const stats = await broadcastStatistics();

        res.json({
            success: true,
            message: "Statistics refreshed successfully.",
            ...stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to refresh statistics."
        });
    }
});

/* ========================================
   GET DRIVER REGISTRATION REQUESTS
   Read actual requests from MySQL
======================================== */
app.get("/api/driver-requests", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                request_id AS id,
                name,
                phone_no AS phone,
                email,
                license_no AS licence,
                experience,
                license_photo,
                status,
                requested_at AS date
            FROM driver_requests
            ORDER BY requested_at DESC
        `);

        res.json({
            success: true,
            requests: rows
        });
    } catch (error) {
        console.error("Driver requests error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to load driver requests."
        });
    }
});

/* ========================================
   ADMIN: GET DRIVER REGISTRATION REQUESTS
   Reads real records from the existing MySQL table
   ======================================== */
app.get("/api/admin/driver-requests", async (req, res) => {
    try {
        const [requests] = await db.query(`
            SELECT
                request_id,
                name,
                phone_no,
                email,
                license_no,
                experience,
                license_photo,
                status,
                requested_at,
                reviewed_at
            FROM driver_requests
            ORDER BY
                CASE
                    WHEN status = 'Pending' THEN 0
                    ELSE 1
                END,
                requested_at DESC
        `);

        res.json({
            success: true,
            requests: requests.map(request => ({
                id: request.request_id,
                name: request.name,
                phone: request.phone_no,
                email: request.email,
                licence: request.license_no,
                license_photo: request.license_photo || null,
                collegeId: "Not provided",
                experience: request.experience !== null && request.experience !== undefined ? request.experience : null,
                date: request.requested_at,
                reviewed_at: request.reviewed_at,
                status: request.status
            }))
        });
    } catch (error) {
        console.error("Driver requests API error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to load driver registration requests."
        });
    }
});

/* ========================================
   ADMIN: UPDATE DRIVER REQUEST STATUS
======================================== */


app.patch("/api/admin/driver-requests/:id/status", async (req, res) => {
    let connection;

    try {
        const requestId = Number(req.params.id);
        const { status, salary, experience } = req.body;

        if (!Number.isInteger(requestId) || requestId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid driver request ID."
            });
        }

        if (!["Pending", "Approved", "Rejected"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid request status."
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [requests] = await connection.execute(
            `SELECT request_id, name, phone_no, email, license_no, experience,
                    password, status
             FROM driver_requests
             WHERE request_id = ?
             FOR UPDATE`,
            [requestId]
        );

        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Driver request not found."
            });
        }

        const request = requests[0];

        if (status === "Approved") {
            const monthlySalary = Number(salary);
            const yearsExperience = (experience !== undefined && experience !== "" && !isNaN(Number(experience)))
                ? Number(experience)
                : (request.experience !== undefined && request.experience !== null ? Number(request.experience) : 0);

            if (
                salary === undefined ||
                salary === "" ||
                !Number.isFinite(monthlySalary) ||
                monthlySalary < 0
            ) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid monthly salary."
                });
            }

            if (
                !Number.isInteger(yearsExperience) ||
                yearsExperience < 0 ||
                yearsExperience > 80
            ) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: "Enter valid experience in years."
                });
            }

            const [existing] = await connection.execute(
                `SELECT driver_id
                 FROM drivers
                 WHERE phone_no = ? OR email = ? OR license_no = ?
                 LIMIT 1`,
                [request.phone_no, request.email, request.license_no]
            );

            if (existing.length > 0) {
                await connection.rollback();
                return res.status(409).json({
                    success: false,
                    message: "A driver with these details already exists."
                });
            }

            await connection.execute(
                `INSERT INTO drivers
                    (name, phone_no, email, license_no, password,
                     status, salary, experience, license_photo)
                 VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
                [
                    request.name,
                    request.phone_no,
                    request.email,
                    request.license_no,
                    request.password,
                    monthlySalary,
                    yearsExperience,
                    request.license_photo || null
                ]
            );

            await connection.execute(
                `UPDATE driver_requests
                 SET status = ?, reviewed_at = NOW(), experience = ?
                 WHERE request_id = ?`,
                [status, yearsExperience, requestId]
            );
        } else {
            await connection.execute(
                `UPDATE driver_requests
                 SET status = ?, reviewed_at = NOW()
                 WHERE request_id = ?`,
                [status, requestId]
            );
        }

        await connection.commit();

        await broadcastStatistics();
        io.emit("driverRequestsUpdated");
        io.emit("driversUpdated");

        return res.json({
            success: true,
            message: status === "Approved"
                ? "Driver approved and saved successfully."
                : `Driver request ${status.toLowerCase()} successfully.`,
            id: requestId,
            status
        });
    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error("Update driver request error:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "These driver details already exist."
            });
        }

        return res.status(500).json({
            success: false,
            message: "Unable to update the driver request."
        });
    } finally {
        if (connection) connection.release();
    }
});

// ========================================
// GET ACTIVE ROUTES (WITH STOPS & BUS INFO)
// ========================================
app.get("/api/routes", async (req, res) => {
    try {
        const [routes] = await db.query(`
            SELECT
                r.route_id,
                r.route_name,
                r.start_location,
                r.end_location,
                b.bus_number,
                b.bus_name
            FROM routes r
            LEFT JOIN buses b
                ON b.route_id = r.route_id AND b.status = 'Active'
            WHERE r.status = 'Active'
            ORDER BY FIELD(r.route_name, 'Route 1') DESC, r.route_name ASC
        `);

        // Retrieve ordered stops for each active route
        for (const route of routes) {
            const [stops] = await db.execute(
                `
                SELECT
                    s.stop_id,
                    s.stop_name,
                    s.location,
                    s.distance_km,
                    rs.stop_order
                FROM route_stops rs
                INNER JOIN stops s
                    ON s.stop_id = rs.stop_id
                WHERE rs.route_id = ?
                  AND s.status = 'Active'
                ORDER BY rs.stop_order ASC
                `,
                [route.route_id]
            );

            route.stops = stops;
            route.stops_count = stops.length;
        }

        res.json({
            success: true,
            routes
        });
    } catch (error) {
        console.error("Routes error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to load routes."
        });
    }
});

// ========================================
// CONTACT FORM SUBMISSION
// ========================================
app.post("/api/contact", async (req, res) => {
    try {
        const { name, email, message } = req.body || {};

        if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Please enter your name."
            });
        }

        if (!email || typeof email !== "string" || !email.trim()) {
            return res.status(400).json({
                success: false,
                message: "Please enter your email address."
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const phoneRegex = /^[0-9+\-\s()]{7,20}$/;
        const trimmedEmail = email.trim();
        if ((!emailRegex.test(trimmedEmail) && !phoneRegex.test(trimmedEmail)) || trimmedEmail.length > 150) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address or phone number."
            });
        }

        if (!message || typeof message !== "string" || !message.trim()) {
            return res.status(400).json({
                success: false,
                message: "Please enter your message."
            });
        }

        const trimmedName = name.trim().slice(0, 100);
        const trimmedMessage = message.trim().slice(0, 5000);

        const [insertResult] = await db.execute(
            `INSERT INTO contact_messages (name, email, message, is_read) VALUES (?, ?, ?, 0)`,
            [trimmedName, trimmedEmail, trimmedMessage]
        );

        if (io) {
            io.emit("newContactMessage", {
                id: insertResult.insertId,
                name: trimmedName,
                email: trimmedEmail,
                message: trimmedMessage,
                created_at: new Date().toISOString()
            });
        }

        if (typeof broadcastStatistics === "function") {
            broadcastStatistics().catch(() => {});
        }

        return res.status(201).json({
            success: true,
            message: "Thank you for reaching out! Your message has been sent successfully."
        });
    } catch (error) {
        console.error("Contact submission error:", error.message);
        return res.status(500).json({
            success: false,
            message: "Unable to send your message right now. Please try again later."
        });
    }
});

// ========================================
// GET STOPS FOR A ROUTE
// ========================================
app.get("/api/routes/:routeId/stops", async (req, res) => {
    try {
        const routeId = Number(req.params.routeId);

        if (!Number.isInteger(routeId) || routeId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid route ID."
            });
        }

        const [stops] = await db.execute(
            `
            SELECT
                s.stop_id,
                s.stop_name,
                s.location
            FROM route_stops rs
            INNER JOIN stops s
                ON s.stop_id = rs.stop_id
            INNER JOIN routes r
                ON r.route_id = rs.route_id
            WHERE rs.route_id = ?
              AND s.status = 'Active'
              AND r.status = 'Active'
            ORDER BY rs.stop_order
            `,
            [routeId]
        );

        res.json({
            success: true,
            stops
        });
    } catch (error) {
        console.error("Pickup points error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to load pickup points."
        });
    }
});

// ========================================
// STUDENT REGISTRATION
// ========================================
app.post("/api/students/register", async (req, res) => {
    try {
        const {
            name,
            branch,
            year,
            roll_number,
            roll_no,
            phone,
            phone_no,
            email,
            password,
            residential_address
        } = req.body;

        const studentName = name?.trim();
        const studentBranch = branch?.trim();
        const studentYear = year;

        const studentRoll = String(
            roll_number ?? roll_no ?? ""
        ).trim();

        const studentPhone = String(
            phone ?? phone_no ?? ""
        ).trim();

        const studentEmail = email?.trim();
        const studentAddress = residential_address?.trim();

        if (
            !studentName ||
            !studentBranch ||
            !studentYear ||
            !studentRoll ||
            !studentPhone ||
            !studentEmail ||
            !password ||
            !studentAddress
        ) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all required student details."
            });
        }

        if (!/^[A-Za-z0-9]{10}$/.test(studentRoll)) {
            return res.status(400).json({
                success: false,
                message: "Roll number must contain exactly 10 letters or numbers."
            });
        }

        if (!/^[0-9]{10}$/.test(studentPhone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must contain exactly 10 digits."
            });
        }

        if (
            typeof password !== "string" ||
            password.length < 8
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must contain at least 8 characters."
            });
        }

        const [existing] = await db.execute(
            `
            SELECT student_id
            FROM students
            WHERE roll_no = ? OR phone_no = ? OR email = ?
            LIMIT 1
            `,
            [studentRoll, studentPhone, studentEmail]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Roll number, phone number, or email is already registered."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const [result] = await db.execute(
            `
            INSERT INTO students
            (
                name,
                branch,
                year,
                roll_no,
                phone_no,
                email,
                password,
                residential_address
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                studentName,
                studentBranch,
                studentYear,
                studentRoll,
                studentPhone,
                studentEmail,
                hashedPassword,
                studentAddress
            ]
        );

        const newStudentId = result.insertId;
        const regRouteId = Number(req.body.route_id);
        const regStopId = Number(req.body.stop_id);
        if (Number.isInteger(regRouteId) && regRouteId > 0 && Number.isInteger(regStopId) && regStopId > 0) {
            const [buses] = await db.execute(
                "SELECT bus_id FROM buses WHERE route_id = ? AND status = 'Active' LIMIT 1",
                [regRouteId]
            );
            const busId = buses.length > 0 ? buses[0].bus_id : null;
            await db.execute(
                "INSERT INTO student_transport (student_id, route_id, stop_id, bus_id, status) VALUES (?, ?, ?, ?, 'Active')",
                [newStudentId, regRouteId, regStopId, busId]
            );
        }

        await broadcastStatistics();
        io.emit("studentsUpdated");

        return res.status(201).json({
            success: true,
            message: "Student registered successfully!"
        });
    } catch (error) {
        console.error("Student registration error:", error.message);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Some student details are already registered."
            });
        }

        return res.status(500).json({
            success: false,
            message: "Student registration failed. Please try again."
        });
    }
});

// ========================================
// DRIVER REGISTRATION
// Driver requests admin approval before login
// ========================================
app.post("/api/drivers/register", handleLicenseUpload, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Driving licence photo is required."
            });
        }

        const {
            name,
            phone,
            phone_no,
            email,
            license_number,
            license_no,
            experience,
            years_experience,
            experience_years,
            password,
            confirm_password
        } = req.body;

        const driverName = name?.trim();
        const driverPhone = String(
            phone ?? phone_no ?? ""
        ).trim();
        const driverEmail = email?.trim();
        const driverLicense = String(
            license_number ?? license_no ?? ""
        ).trim();
        const rawExperience = experience ?? years_experience ?? experience_years;
        const driverExperience = (rawExperience !== undefined && rawExperience !== "" && !isNaN(Number(rawExperience)))
            ? Number(rawExperience)
            : NaN;

        if (
            !driverName ||
            !driverPhone ||
            !driverEmail ||
            !driverLicense ||
            rawExperience === undefined ||
            rawExperience === "" ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all required driver details, including experience."
            });
        }

        if (!Number.isInteger(driverExperience) || driverExperience < 0 || driverExperience > 60) {
            return res.status(400).json({
                success: false,
                message: "Please enter valid driving experience in years (0 - 60)."
            });
        }

        if (!/^[0-9]{10}$/.test(driverPhone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must contain exactly 10 digits."
            });
        }

        if (driverLicense.length > 30) {
            return res.status(400).json({
                success: false,
                message: "License number must not exceed 30 characters."
            });
        }

        if (typeof password !== "string" || password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must contain at least 8 characters."
            });
        }

        if (
            confirm_password !== undefined &&
            password !== confirm_password
        ) {
            return res.status(400).json({
                success: false,
                message: "Passwords do not match."
            });
        }

        const [existingDrivers] = await db.execute(
            `SELECT driver_id
             FROM drivers
             WHERE phone_no = ? OR email = ? OR license_no = ?
             LIMIT 1`,
            [driverPhone, driverEmail, driverLicense]
        );

        if (existingDrivers.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Phone number, email, or license number is already registered."
            });
        }

        const [existingRequests] = await db.execute(
            `SELECT request_id
             FROM driver_requests
             WHERE (phone_no = ? OR email = ? OR license_no = ?)
               AND status = 'Pending'
             LIMIT 1`,
            [driverPhone, driverEmail, driverLicense]
        );

        if (existingRequests.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A driver registration request with these details is already pending."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const licensePhoto = "/uploads/licenses/" + req.file.filename;

        await db.execute(
            `INSERT INTO driver_requests
                (name, phone_no, email, license_no, experience, password, license_photo, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [
                driverName,
                driverPhone,
                driverEmail,
                driverLicense,
                driverExperience,
                hashedPassword,
                licensePhoto
            ]
        );

        await broadcastStatistics();
        io.emit("driverRequestsUpdated");

        return res.status(201).json({
            success: true,
            message: "Registration request submitted successfully. Please wait for admin approval."
        });

    } catch (error) {
        console.error("Driver registration error:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Some driver details are already registered or requested."
            });
        }

        return res.status(500).json({
            success: false,
            message: "Driver registration request failed. Please try again."
        });
    }
});

// ========================================
// LOGIN: STUDENT, DRIVER, ADMIN
// ========================================
app.post("/api/auth/login", async (req, res) => {
    try {
        const {
            role,
            identifier,
            email,
            roll_no,
            phone_no,
            password
        } = req.body;

        const selectedRole = String(role || "")
            .trim()
            .toLowerCase();

        const loginIdentifier = String(
            identifier ?? email ?? roll_no ?? phone_no ?? ""
        ).trim();

        if (!["student", "driver", "admin"].includes(selectedRole)) {
            return res.status(400).json({
                success: false,
                message: "Please select a valid login role."
            });
        }

        if (
            !loginIdentifier ||
            typeof password !== "string" ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter your login details."
            });
        }

        let user;
        let passwordHash;
        let userId;
        let userName;
        let userEmail;

        // STUDENT LOGIN
        if (selectedRole === "student") {
            const [rows] = await db.execute(
                `
                SELECT
                    student_id,
                    name,
                    email,
                    roll_no,
                    phone_no,
                    password
                FROM students
                WHERE email = ? OR roll_no = ? OR phone_no = ?
                LIMIT 1
                `,
                [
                    loginIdentifier,
                    loginIdentifier,
                    loginIdentifier
                ]
            );

            user = rows[0];

            if (user) {
                passwordHash = user.password;
                userId = user.student_id;
                userName = user.name;
                userEmail = user.email;
            }
        }

        // DRIVER LOGIN
        // Only drivers in the drivers table can log in.
        // Pending driver requests are not login accounts.
        else if (selectedRole === "driver") {
            const [rows] = await db.execute(
                `
                SELECT
                    driver_id,
                    name,
                    email,
                    phone_no,
                    password,
                    status
                FROM drivers
                WHERE email = ? OR phone_no = ?
                LIMIT 1
                `,
                [loginIdentifier, loginIdentifier]
            );

            user = rows[0];

            if (user) {
                passwordHash = user.password;
                userId = user.driver_id;
                userName = user.name;
                userEmail = user.email;

                if (
                    user.status &&
                    String(user.status).toLowerCase() !== "active"
                ) {
                    return res.status(403).json({
                        success: false,
                        message: "Your driver account is not active. Contact the Transportation Office."
                    });
                }
            } else {
                // Check if this driver has a pending or rejected registration request
                const [reqRows] = await db.execute(
                    `
                    SELECT request_id, name, email, phone_no, status
                    FROM driver_requests
                    WHERE email = ? OR phone_no = ?
                    ORDER BY request_id DESC
                    LIMIT 1
                    `,
                    [loginIdentifier, loginIdentifier]
                );

                if (reqRows.length > 0) {
                    const reqRecord = reqRows[0];
                    if (reqRecord.status === "Pending") {
                        return res.status(403).json({
                            success: false,
                            approval_status: "Pending",
                            message: "Your registration request is pending admin approval. You will receive dashboard access once approved."
                        });
                    } else if (reqRecord.status === "Rejected") {
                        return res.status(403).json({
                            success: false,
                            approval_status: "Rejected",
                            message: "Your driver registration request has been rejected by the administrator. Contact the Transportation Office."
                        });
                    }
                }
            }
        }

        // ADMIN LOGIN
        else if (selectedRole === "admin") {
            const [rows] = await db.execute(
                `
                SELECT
                    admin_id,
                    name,
                    phone_no,
                    email,
                    password
                FROM admins
                WHERE email = ? OR phone_no = ?
                LIMIT 1
                `,
                [loginIdentifier, loginIdentifier]
            );

            user = rows[0];

            if (user) {
                passwordHash = user.password;
                userId = user.admin_id;
                userName = user.name;
                userEmail = user.email;
            }
        }

        if (!user || !passwordHash) {
            return res.status(401).json({
                success: false,
                message: "Invalid login credentials."
            });
        }

        let passwordMatches = false;

        try {
            passwordMatches = await bcrypt.compare(
                password,
                passwordHash
            );
        } catch {
            passwordMatches = false;
        }

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                message: "Invalid login credentials."
            });
        }

        return res.json({
            success: true,
            message: "Login successful!",
            user: {
                id: userId,
                name: userName,
                email: userEmail,
                role: selectedRole
            }
        });
    } catch (error) {
        console.error("Login error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Login failed. Please try again."
        });
    }
});

// ========================================
// SOCKET.IO CONNECTION
// ========================================
io.on("connection", (socket) => {
    getStatistics()
        .then(stats => {
            socket.emit("statsUpdated", {
                success: true,
                ...stats
            });
        })
        .catch(error => {
            console.error(
                "Initial statistics error:",
                error.message
            );
        });

    // CHANGE 4: Student room & live tracking subscription with pass cancellation gating
    socket.on("joinStudentRoom", async (data) => {
        try {
            const studentId = data?.student_id;
            if (!studentId) return;
            socket.studentId = studentId;
            const isCancelled = await isStudentPassCancelled(db, studentId);
            if (isCancelled) {
                socket.isCancelledStudent = true;
                socket.leave("tracking");
                socket.emit("trackingDenied", {
                    message: "Live tracking is unavailable because your bus pass is cancelled."
                });
                return;
            }
            socket.isCancelledStudent = false;
            socket.join(`student_${studentId}`);
            socket.join("tracking");
        } catch (e) {
            console.error("Socket joinStudentRoom error:", e.message);
        }
    });

    socket.on("joinTrackingRoom", async (data) => {
        try {
            const studentId = data?.student_id || socket.studentId;
            if (studentId) {
                const isCancelled = await isStudentPassCancelled(db, studentId);
                if (isCancelled) {
                    socket.isCancelledStudent = true;
                    socket.leave("tracking");
                    socket.emit("trackingDenied", {
                        message: "Live tracking is unavailable because your bus pass is cancelled."
                    });
                    return;
                }
            }
            socket.isCancelledStudent = false;
            socket.join("tracking");
        } catch (e) {
            console.error("Socket joinTrackingRoom error:", e.message);
        }
    });

    socket.on("driverLocationUpdate", async (data) => {
        try {
            if (!data || !data.busId || data.latitude === undefined || data.longitude === undefined) return;
            const busId = Number(data.busId);
            const tripId = data.tripId ? Number(data.tripId) : null;
            const lat = Number(data.latitude);
            const lng = Number(data.longitude);
            const speed = data.speed ? Number(data.speed) : 0;
            const heading = data.heading ? Number(data.heading) : 0;

            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                await db.execute(
                    "INSERT INTO live_locations (trip_id, bus_id, latitude, longitude, speed, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
                    [tripId, busId, lat, lng, speed, heading]
                );

                const locPayload = {
                    bus_id: busId,
                    trip_id: tripId,
                    latitude: lat,
                    longitude: lng,
                    speed,
                    heading,
                    recorded_at: new Date().toISOString()
                };

                // Emit location only to sockets that are NOT cancelled students
                for (const [id, s] of io.of("/").sockets) {
                    if (s.isCancelledStudent) continue;
                    s.emit("busLocationUpdated", locPayload);
                    s.emit("driverLocationUpdated", locPayload);
                }
            }
        } catch (err) {
            console.error("Socket driverLocationUpdate error:", err.message);
        }
    });
});

// ========================================
// AUTOMATIC STATISTICS MONITOR
// Checks MySQL every 3 seconds and broadcasts
// only when dashboard counts change.
// ========================================
let previousStatistics = null;
let statisticsCheckRunning = false;

async function monitorStatistics() {
    if (statisticsCheckRunning) {
        return;
    }

    statisticsCheckRunning = true;

    try {
        const currentStatistics = await getStatistics();
        const currentSnapshot = JSON.stringify(currentStatistics);

        if (currentSnapshot !== previousStatistics) {
            previousStatistics = currentSnapshot;

            io.emit("statsUpdated", {
                success: true,
                ...currentStatistics
            });
        }
    } catch (error) {
        console.error(
            "Automatic statistics check failed:",
            error.message
        );
    } finally {
        statisticsCheckRunning = false;
    }
}
// ==========================================
// GET ALL STUDENTS
// ==========================================
// ==========================================
// GET ALL STUDENTS
// ==========================================

app.get("/api/students", async (req, res) => {
    try {
        const [students] = await db.query(`
            SELECT
                student_id,
                name,
                branch,
                year,
                roll_no,
                phone_no,
                email,
                photo_url,
                created_at,
                residential_address
            FROM students
            WHERE status = 'active'
            ORDER BY student_id DESC
        `);

        res.json({
            success: true,
            total: students.length,
            students
        });

    } catch (error) {
        console.error("Error fetching students:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


/* ========================================
   ADMIN: DELETE STUDENT
======================================== */

/* ========================================
   ADMIN: DEACTIVATE STUDENT
======================================== */
app.delete("/api/students/:id", async (req, res) => {
    try {
        const studentId = Number(req.params.id);

        if (!Number.isInteger(studentId) || studentId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid student ID."
            });
        }

        const [result] = await db.execute(
            `UPDATE students
             SET status = 'inactive'
             WHERE student_id = ? AND status = 'active'`,
            [studentId]
        );

        if (result.affectedRows === 0) {
            const [rows] = await db.execute(
                "SELECT status FROM students WHERE student_id = ?",
                [studentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Student not found."
                });
            }

            return res.json({
                success: true,
                message: "Student is already inactive."
            });
        }

        await broadcastStatistics();

        return res.json({
            success: true,
            message: "Student deactivated successfully.",
            studentId
        });

    } catch (error) {
        console.error("Deactivate student error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to deactivate student."
        });
    }
});


// ==========================================
// GET ALL BUSES
// ==========================================
app.get("/api/buses", async (req, res) => {
    try {
        const [buses] = await db.query(`
            SELECT
                bus_id,
                bus_number,
                bus_name,
                capacity,
                status
            FROM buses
            ORDER BY bus_id DESC
        `);

        res.json({
            success: true,
            total: buses.length,
            buses
        });

    } catch (error) {
        console.error("Error fetching buses:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});
// ========================================
// ADMIN: CREATE STUDENT
// ========================================
app.post("/api/admin/students", async (req, res) => {
    let connection;

    try {
        const {
            name,
            branch,
            year,
            roll_no,
            phone_no,
            email,
            residential_address,
            password,
            confirm_password,
            route_id,
            stop_id,
            bus_id
        } = req.body;

        const studentName = String(name || "").trim();
        const studentBranch = String(branch || "").trim();
        const studentYear = String(year || "").trim();
        const studentRoll = String(roll_no || "").trim();
        const studentPhone = String(phone_no || "").trim();
        const studentEmail = String(email || "").trim();
        const studentAddress = String(residential_address || "").trim();

        const routeId = Number(route_id);
        const stopId = Number(stop_id);
        const busId = Number(bus_id);

        if (
            !studentName || !studentBranch || !studentYear ||
            !studentRoll || !studentPhone || !studentEmail ||
            !studentAddress || !password || !confirm_password
        ) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all required fields."
            });
        }

        if (!/^[A-Za-z0-9]{10}$/.test(studentRoll)) {
            return res.status(400).json({
                success: false,
                message: "Roll number must contain exactly 10 letters or numbers."
            });
        }

        if (!/^[0-9]{10}$/.test(studentPhone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must contain exactly 10 digits."
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail)) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid email address."
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must contain at least 8 characters."
            });
        }

        if (password !== confirm_password) {
            return res.status(400).json({
                success: false,
                message: "Passwords do not match."
            });
        }

        if (
            !Number.isInteger(routeId) || routeId <= 0 ||
            !Number.isInteger(stopId) || stopId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Select a valid route and pickup point."
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [duplicates] = await connection.execute(
            `SELECT student_id
             FROM students
             WHERE roll_no = ? OR phone_no = ? OR email = ?
             LIMIT 1`,
            [studentRoll, studentPhone, studentEmail]
        );

        if (duplicates.length) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "Roll number, phone number or email already exists."
            });
        }

        const [routeRows] = await connection.execute(
            `SELECT route_id
             FROM routes
             WHERE route_id = ? AND status = 'Active'`,
            [routeId]
        );

        if (!routeRows.length) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Selected route is not active."
            });
        }

        const [stopRows] = await connection.execute(
            `SELECT s.stop_id
             FROM route_stops rs
             JOIN stops s ON s.stop_id = rs.stop_id
             WHERE rs.route_id = ?
               AND s.stop_id = ?
               AND s.status = 'Active'`,
            [routeId, stopId]
        );

        if (!stopRows.length) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "The selected pickup point does not belong to this route."
            });
        }

        if (Number.isInteger(busId) && busId > 0) {
            const [busRows] = await connection.execute(
                `SELECT bus_id
                 FROM buses
                 WHERE bus_id = ?`,
                [busId]
            );

            if (!busRows.length) {
                await connection.rollback();

                return res.status(400).json({
                    success: false,
                    message: "Selected bus does not exist."
                });
            }
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const [insertResult] = await connection.execute(
            `INSERT INTO students
                (name, branch, year, roll_no, phone_no, email,
                 password, residential_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                studentName,
                studentBranch,
                studentYear,
                studentRoll,
                studentPhone,
                studentEmail,
                passwordHash,
                studentAddress
            ]
        );

        let finalBusId = (Number.isInteger(busId) && busId > 0) ? busId : null;
        if (!finalBusId && Number.isInteger(routeId) && routeId > 0) {
            const [buses] = await connection.execute(
                "SELECT bus_id FROM buses WHERE route_id = ? AND status = 'Active' LIMIT 1",
                [routeId]
            );
            if (buses.length > 0) finalBusId = buses[0].bus_id;
        }

        if (Number.isInteger(routeId) && routeId > 0 && Number.isInteger(stopId) && stopId > 0) {
            await connection.execute(
                `INSERT INTO student_transport
                    (student_id, route_id, bus_id, stop_id, status)
                 VALUES (?, ?, ?, ?, 'Active')`,
                [insertResult.insertId, routeId, finalBusId, stopId]
            );
        }

        await connection.commit();

        await broadcastStatistics();
        io.emit("studentsUpdated");

        return res.status(201).json({
            success: true,
            message: "Student added successfully.",
            studentId: insertResult.insertId
        });
    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error("Admin create student error:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Some student details already exist."
            });
        }

        return res.status(500).json({
            success: false,
            message: "Unable to add student."
        });
    } finally {
        if (connection) connection.release();
    }
});


// ========================================
// ADMIN: UPDATE STUDENT
// Password is optional when editing.
// ========================================
app.put("/api/admin/students/:id", async (req, res) => {
    let connection;

    try {
        const studentId = Number(req.params.id);

        if (!Number.isInteger(studentId) || studentId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid student ID."
            });
        }

        const {
            name,
            branch,
            year,
            roll_no,
            phone_no,
            email,
            residential_address,
            password,
            confirm_password,
            route_id,
            stop_id,
            bus_id
        } = req.body;

        const studentName = String(name || "").trim();
        const studentBranch = String(branch || "").trim();
        const studentYear = String(year || "").trim();
        const studentRoll = String(roll_no || "").trim();
        const studentPhone = String(phone_no || "").trim();
        const studentEmail = String(email || "").trim();
        const studentAddress = String(residential_address || "").trim();

        const routeId = Number(route_id);
        const stopId = Number(stop_id);
        const busId = Number(bus_id);

        if (
            !studentName || !studentBranch || !studentYear ||
            !studentRoll || !studentPhone || !studentEmail ||
            !studentAddress
        ) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all required student fields."
            });
        }

        if (!/^[A-Za-z0-9]{10}$/.test(studentRoll)) {
            return res.status(400).json({
                success: false,
                message: "Roll number must contain exactly 10 letters or numbers."
            });
        }

        if (!/^[0-9]{10}$/.test(studentPhone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must contain exactly 10 digits."
            });
        }

        if (
            password &&
            (typeof password !== "string" || password.length < 8)
        ) {
            return res.status(400).json({
                success: false,
                message: "A new password must contain at least 8 characters."
            });
        }

        if (password && password !== confirm_password) {
            return res.status(400).json({
                success: false,
                message: "Passwords do not match."
            });
        }

        if (
            !Number.isInteger(routeId) || routeId <= 0 ||
            !Number.isInteger(stopId) || stopId <= 0 ||
            !Number.isInteger(busId) || busId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Select a valid route, pickup point and bus."
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [students] = await connection.execute(
            `SELECT student_id
             FROM students
             WHERE student_id = ? AND status = 'active'
             FOR UPDATE`,
            [studentId]
        );

        if (!students.length) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Active student not found."
            });
        }

        const [duplicates] = await connection.execute(
            `SELECT student_id
             FROM students
             WHERE (roll_no = ? OR phone_no = ? OR email = ?)
               AND student_id <> ?
             LIMIT 1`,
            [studentRoll, studentPhone, studentEmail, studentId]
        );

        if (duplicates.length) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "Roll number, phone number or email belongs to another student."
            });
        }

        const [stopRows] = await connection.execute(
            `SELECT s.stop_id
             FROM route_stops rs
             JOIN stops s ON s.stop_id = rs.stop_id
             JOIN routes r ON r.route_id = rs.route_id
             WHERE rs.route_id = ?
               AND s.stop_id = ?
               AND s.status = 'Active'
               AND r.status = 'Active'`,
            [routeId, stopId]
        );

        const [busRows] = await connection.execute(
            `SELECT bus_id FROM buses WHERE bus_id = ?`,
            [busId]
        );

        if (!stopRows.length || !busRows.length) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Invalid route, pickup point or bus."
            });
        }

        if (password) {
            const passwordHash = await bcrypt.hash(password, 10);

            await connection.execute(
                `UPDATE students
                 SET name = ?, branch = ?, year = ?, roll_no = ?,
                     phone_no = ?, email = ?, residential_address = ?,
                     password = ?
                 WHERE student_id = ?`,
                [
                    studentName,
                    studentBranch,
                    studentYear,
                    studentRoll,
                    studentPhone,
                    studentEmail,
                    studentAddress,
                    passwordHash,
                    studentId
                ]
            );
        } else {
            await connection.execute(
                `UPDATE students
                 SET name = ?, branch = ?, year = ?, roll_no = ?,
                     phone_no = ?, email = ?, residential_address = ?
                 WHERE student_id = ?`,
                [
                    studentName,
                    studentBranch,
                    studentYear,
                    studentRoll,
                    studentPhone,
                    studentEmail,
                    studentAddress,
                    studentId
                ]
            );
        }

        let finalBusId = (Number.isInteger(busId) && busId > 0) ? busId : null;
        if (!finalBusId && Number.isInteger(routeId) && routeId > 0) {
            const [buses] = await connection.execute(
                "SELECT bus_id FROM buses WHERE route_id = ? AND status = 'Active' LIMIT 1",
                [routeId]
            );
            if (buses.length > 0) finalBusId = buses[0].bus_id;
        }

        if (Number.isInteger(routeId) && routeId > 0 && Number.isInteger(stopId) && stopId > 0) {
            const [assignments] = await connection.execute(
                `SELECT transport_id
                 FROM student_transport
                 WHERE student_id = ?
                 ORDER BY transport_id DESC
                 LIMIT 1
                 FOR UPDATE`,
                [studentId]
            );

            if (assignments.length) {
                await connection.execute(
                    `UPDATE student_transport
                     SET route_id = ?, bus_id = ?, stop_id = ?, status = 'Active'
                     WHERE transport_id = ?`,
                    [
                        routeId,
                        finalBusId,
                        stopId,
                        assignments[0].transport_id
                    ]
                );
            } else {
                await connection.execute(
                    `INSERT INTO student_transport
                        (student_id, route_id, bus_id, stop_id, status)
                     VALUES (?, ?, ?, ?, 'Active')`,
                    [studentId, routeId, finalBusId, stopId]
                );
            }
        }

        await connection.commit();

        await broadcastStatistics();
        io.emit("studentsUpdated");

        return res.json({
            success: true,
            message: "Student updated successfully."
        });
    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error("Admin update student error:", error);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Some student details already exist."
            });
        }

        return res.status(500).json({
            success: false,
            message: "Unable to update student."
        });
    } finally {
        if (connection) connection.release();
    }
});
// ========================================
// REGISTER COMPLETE ADMIN & DRIVER ROUTES
// ========================================
registerAdminRoutes(app, db, io, broadcastStatistics, handleLicenseUpload);
registerDriverRoutes(app, db, io, broadcastStatistics);
registerStudentRoutes(app, db, io, broadcastStatistics);

// ========================================
// START SERVER
// ========================================
server.listen(PORT, async () => {
    console.log(
        `CampusGo server running at http://localhost:${PORT}`
    );

    try {
        const [rows] = await db.query(
            "SELECT DATABASE() AS databaseName"
        );

        console.log(
            `Connected to MySQL database: ${rows[0].databaseName}`
        );

        await monitorStatistics();

        // Detect direct MySQL changes every 3 seconds.
        setInterval(monitorStatistics, 3000);
    } catch (error) {
        console.error(
            "MySQL connection or statistics error:",
            error.message
        );
    }
});
