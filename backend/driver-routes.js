"use strict";

const express = require("express");
const { calculateDistanceFee } = require("./admin-routes");

/**
 * Calculates straight-line distance in meters between two lat/long points using Haversine formula
 */
function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = (Number(lat1) * Math.PI) / 180;
    const phi2 = (Number(lat2) * Math.PI) / 180;
    const deltaPhi = ((Number(lat2) - Number(lat1)) * Math.PI) / 180;
    const deltaLambda = ((Number(lon2) - Number(lon1)) * Math.PI) / 180;

    const a =
        Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Helper to fetch driver's active assigned bus and resolved route
 */
async function getDriverBusAndRoute(db, driverId) {
    const [assignments] = await db.query(
        `
        SELECT
            ba.assignment_id,
            ba.bus_id,
            ba.assignment_date,
            ba.status AS assignment_status,
            b.bus_number,
            b.bus_name,
            b.capacity,
            b.status AS bus_status,
            b.route_id AS bus_route_id,
            COALESCE(
                b.route_id,
                (SELECT route_id FROM student_transport WHERE bus_id = b.bus_id AND (status IS NULL OR status NOT IN ('Cancelled', 'Inactive')) LIMIT 1),
                (SELECT route_id FROM trips WHERE bus_id = b.bus_id ORDER BY trip_id DESC LIMIT 1)
            ) AS route_id,
            r.route_name,
            r.start_location,
            r.end_location,
            r.status AS route_status
        FROM bus_assignments ba
        JOIN buses b ON ba.bus_id = b.bus_id
        LEFT JOIN routes r ON r.route_id = COALESCE(
            b.route_id,
            (SELECT route_id FROM student_transport WHERE bus_id = b.bus_id AND (status IS NULL OR status NOT IN ('Cancelled', 'Inactive')) LIMIT 1),
            (SELECT route_id FROM trips WHERE bus_id = b.bus_id ORDER BY trip_id DESC LIMIT 1)
        )
        WHERE ba.driver_id = ? AND ba.status = 'Active'
        ORDER BY ba.assignment_id DESC
        LIMIT 1
        `,
        [driverId]
    );

    return assignments.length > 0 ? assignments[0] : null;
}

function registerDriverRoutes(app, db, io, broadcastStatistics) {
    const router = express.Router();

    /**
     * Authentication & Approval Guard Middleware:
     * Verifies driver identity and ensures they are in `drivers` table with `status = 'Active'`.
     */
    async function authDriver(req, res, next) {
        try {
            const rawId =
                req.headers["x-driver-id"] ||
                req.headers["driver-id"] ||
                req.query.driver_id ||
                (req.body && req.body.driver_id);

            const driverId = Number(rawId);

            if (!Number.isInteger(driverId) || driverId <= 0) {
                return res.status(401).json({
                    success: false,
                    message: "Driver authentication required. Please log in."
                });
            }

            const [rows] = await db.execute(
                `
                SELECT driver_id, name, phone_no, email, license_no, status, salary, experience
                FROM drivers
                WHERE driver_id = ?
                LIMIT 1
                `,
                [driverId]
            );

            if (rows.length === 0) {
                // Check if driver is pending or rejected in driver_requests
                const [reqs] = await db.execute(
                    `SELECT status FROM driver_requests WHERE request_id = ? LIMIT 1`,
                    [driverId]
                );

                if (reqs.length > 0) {
                    const reqStatus = reqs[0].status;
                    return res.status(403).json({
                        success: false,
                        approval_status: reqStatus,
                        message: reqStatus === "Pending"
                            ? "Your registration request is pending admin approval."
                            : "Your driver registration request has been rejected."
                    });
                }

                return res.status(401).json({
                    success: false,
                    message: "Driver account not found. Please log in again."
                });
            }

            const driver = rows[0];

            if (String(driver.status).toLowerCase() !== "active") {
                return res.status(403).json({
                    success: false,
                    approval_status: driver.status,
                    message: "Your driver account is inactive or suspended. Access denied."
                });
            }

            req.driver = driver;
            next();
        } catch (error) {
            console.error("Driver auth middleware error:", error);
            res.status(500).json({ success: false, message: "Authentication check failed." });
        }
    }

    // Apply driver auth middleware to all /api/driver routes
    router.use(authDriver);

    // ==========================================
    // 1. DRIVER PROFILE
    // ==========================================
    router.get("/profile", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            // Fetch registration date from driver_requests if matched by email/phone
            let registrationDate = null;
            try {
                const [reqRow] = await db.execute(
                    "SELECT requested_at FROM driver_requests WHERE email = ? OR phone_no = ? ORDER BY request_id DESC LIMIT 1",
                    [driver.email, driver.phone_no]
                );
                if (reqRow.length > 0) {
                    registrationDate = reqRow[0].requested_at;
                }
            } catch (_) {}

            res.json({
                success: true,
                profile: {
                    driver_id: driver.driver_id,
                    name: driver.name,
                    phone_no: driver.phone_no,
                    email: driver.email,
                    license_no: driver.license_no,
                    status: driver.status,
                    approval_status: "Approved",
                    experience: driver.experience,
                    registration_date: registrationDate,
                    assigned_bus: assignment ? {
                        bus_id: assignment.bus_id,
                        bus_number: assignment.bus_number,
                        bus_name: assignment.bus_name,
                        capacity: assignment.capacity,
                        status: assignment.bus_status
                    } : null,
                    assigned_route: assignment && assignment.route_id ? {
                        route_id: assignment.route_id,
                        route_name: assignment.route_name,
                        start_location: assignment.start_location,
                        end_location: assignment.end_location
                    } : null
                }
            });
        } catch (error) {
            console.error("Fetch driver profile error:", error);
            res.status(500).json({ success: false, message: "Unable to load driver profile." });
        }
    });

    // ==========================================
    // 2. MY ASSIGNED BUS
    // ==========================================
    router.get("/bus", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment) {
                return res.json({
                    success: true,
                    assigned: false,
                    message: "No bus has been assigned to you yet."
                });
            }

            // Check active trip status for this bus
            const [activeTrips] = await db.query(
                "SELECT trip_id, status, start_time FROM trips WHERE bus_id = ? AND status = 'Started' ORDER BY trip_id DESC LIMIT 1",
                [assignment.bus_id]
            );

            const activeTrip = activeTrips.length > 0 ? activeTrips[0] : null;

            res.json({
                success: true,
                assigned: true,
                bus: {
                    bus_id: assignment.bus_id,
                    bus_number: assignment.bus_number,
                    bus_name: assignment.bus_name,
                    capacity: assignment.capacity,
                    bus_status: assignment.bus_status,
                    assignment_id: assignment.assignment_id,
                    assignment_date: assignment.assignment_date,
                    assigned_route: assignment.route_id ? {
                        route_id: assignment.route_id,
                        route_name: assignment.route_name,
                        start_location: assignment.start_location,
                        end_location: assignment.end_location
                    } : null,
                    current_trip: activeTrip ? {
                        trip_id: activeTrip.trip_id,
                        status: activeTrip.status,
                        start_time: activeTrip.start_time
                    } : null,
                    trip_status: activeTrip ? "In Transit" : "Idle",
                    assigned_driver: {
                        driver_id: driver.driver_id,
                        name: driver.name,
                        phone_no: driver.phone_no
                    }
                }
            });
        } catch (error) {
            console.error("Fetch assigned bus error:", error);
            res.status(500).json({ success: false, message: "Unable to load assigned bus details." });
        }
    });

    // ==========================================
    // 3. MY STUDENTS & PAYMENT STATUS
    // ==========================================
    router.get("/students", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment) {
                return res.json({
                    success: true,
                    assigned: false,
                    bus_number: null,
                    summary: {
                        totalStudents: 0,
                        paidStudents: 0,
                        unpaidStudents: 0,
                        partiallyPaidStudents: 0,
                        pendingVerification: 0
                    },
                    students: []
                });
            }

            // Fetch students assigned to this bus via student_transport
            const [students] = await db.query(
                `
                SELECT
                    s.student_id,
                    s.name AS student_name,
                    s.roll_no,
                    s.branch,
                    s.year,
                    s.phone_no,
                    s.email,
                    st.transport_id,
                    st.status AS transport_status,
                    r.route_id,
                    r.route_name,
                    sp.stop_id,
                    sp.stop_name,
                    sp.location AS stop_location,
                    sp.distance_km,
                    f.fee_id,
                    f.amount AS stop_fee
                FROM (
                    SELECT student_id, MAX(transport_id) AS max_tid
                    FROM student_transport
                    GROUP BY student_id
                ) latest_st
                JOIN student_transport st ON latest_st.max_tid = st.transport_id
                JOIN students s ON st.student_id = s.student_id
                JOIN routes r ON st.route_id = r.route_id
                JOIN stops sp ON st.stop_id = sp.stop_id
                LEFT JOIN fees f ON sp.stop_id = f.stop_id AND f.status = 'Active'
                WHERE (st.bus_id = ? OR (st.bus_id IS NULL AND st.route_id = ?))
                  AND (st.status IS NULL OR st.status NOT IN ('Cancelled', 'Inactive'))
                  AND s.status = 'active'
                ORDER BY sp.distance_km ASC, s.name ASC
                `,
                [assignment.bus_id, assignment.route_id]
            );

            // For each student, calculate payments
            let paidCount = 0;
            let unpaidCount = 0;
            let partialCount = 0;
            let pendingCount = 0;

            const studentList = [];

            for (const st of students) {
                const [payments] = await db.query(
                    `
                    SELECT
                        payment_id,
                        amount,
                        payment_status,
                        payment_date
                    FROM payments
                    WHERE student_id = ?
                    ORDER BY payment_id DESC
                    `,
                    [st.student_id]
                );

                const stopDist = Number(st.distance_km || 0);
                const configuredFee = Number(st.stop_fee || 0);
                const requiredFee = configuredFee > 0 ? configuredFee : calculateDistanceFee(stopDist);
                let totalVerified = 0;
                let hasPending = false;

                for (const p of payments) {
                    if (p.payment_status === "Success") {
                        totalVerified += Number(p.amount) || 0;
                    } else if (p.payment_status === "Pending") {
                        hasPending = true;
                    }
                }

                let paymentStatus = "Unpaid";
                if (totalVerified >= requiredFee) {
                    paymentStatus = "Paid";
                    paidCount++;
                } else if (totalVerified > 0) {
                    paymentStatus = "Partially Paid";
                    partialCount++;
                } else if (hasPending) {
                    paymentStatus = "Pending Verification";
                    pendingCount++;
                } else {
                    paymentStatus = "Unpaid";
                    unpaidCount++;
                }

                const amountDue = Math.max(0, requiredFee - totalVerified);

                studentList.push({
                    student_id: st.student_id,
                    student_name: st.student_name,
                    roll_no: st.roll_no,
                    branch: st.branch,
                    year: st.year,
                    phone_no: st.phone_no,
                    route_id: st.route_id,
                    route_name: st.route_name,
                    stop_id: st.stop_id,
                    stop_name: st.stop_name,
                    distance_km: st.distance_km,
                    fee_amount: requiredFee,
                    verified_paid: totalVerified,
                    amount_due: amountDue,
                    payment_status: paymentStatus
                });
            }

            res.json({
                success: true,
                assigned: true,
                bus_id: assignment.bus_id,
                bus_number: assignment.bus_number,
                summary: {
                    totalStudents: studentList.length,
                    paidStudents: paidCount,
                    unpaidStudents: unpaidCount,
                    partiallyPaidStudents: partialCount,
                    pendingVerification: pendingCount
                },
                students: studentList
            });
        } catch (error) {
            console.error("Fetch driver students error:", error);
            res.status(500).json({ success: false, message: "Unable to load student list." });
        }
    });

    // ==========================================
    // 4. ROUTE & ORDERED STOPS
    // ==========================================
    router.get("/route", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment || !assignment.route_id) {
                return res.json({
                    success: true,
                    assigned: false,
                    message: "No route is currently assigned to your bus.",
                    route: null,
                    stops: []
                });
            }

            // Fetch route details
            const [routeRows] = await db.query(
                "SELECT route_id, route_name, start_location, end_location, status FROM routes WHERE route_id = ?",
                [assignment.route_id]
            );

            if (routeRows.length === 0) {
                return res.status(404).json({ success: false, message: "Assigned route not found." });
            }

            const route = routeRows[0];

            // Fetch ordered stops
            const [stops] = await db.query(
                `
                SELECT
                    rs.route_stop_id,
                    rs.stop_order,
                    s.stop_id,
                    s.stop_name,
                    s.location AS landmark,
                    s.distance_km,
                    s.latitude,
                    s.longitude,
                    s.status
                FROM route_stops rs
                JOIN stops s ON rs.stop_id = s.stop_id
                WHERE rs.route_id = ?
                ORDER BY rs.stop_order ASC
                `,
                [assignment.route_id]
            );

            // Count students assigned to this bus at each stop
            const [studentCounts] = await db.query(
                `
                SELECT
                    st.stop_id,
                    COUNT(DISTINCT st.student_id) AS student_count,
                    GROUP_CONCAT(DISTINCT s.name SEPARATOR ', ') AS student_names
                FROM (
                    SELECT student_id, MAX(transport_id) AS max_tid
                    FROM student_transport
                    GROUP BY student_id
                ) latest_st
                JOIN student_transport st ON latest_st.max_tid = st.transport_id
                JOIN students s ON st.student_id = s.student_id
                WHERE (st.bus_id = ? OR (st.bus_id IS NULL AND st.route_id = ?))
                  AND (st.status IS NULL OR st.status NOT IN ('Cancelled', 'Inactive'))
                  AND s.status = 'active'
                GROUP BY st.stop_id
                `,
                [assignment.bus_id, assignment.route_id]
            );

            const countMap = {};
            for (const sc of studentCounts) {
                countMap[sc.stop_id] = {
                    count: Number(sc.student_count) || 0,
                    names: sc.student_names || ""
                };
            }

            const orderedStops = stops.map(stop => ({
                stop_id: stop.stop_id,
                stop_order: stop.stop_order,
                stop_name: stop.stop_name,
                landmark: stop.landmark,
                distance_km: stop.distance_km,
                latitude: stop.latitude,
                longitude: stop.longitude,
                status: stop.status,
                student_count: countMap[stop.stop_id]?.count || 0,
                student_names: countMap[stop.stop_id]?.names || ""
            }));

            res.json({
                success: true,
                assigned: true,
                bus_id: assignment.bus_id,
                bus_number: assignment.bus_number,
                route: {
                    route_id: route.route_id,
                    route_name: route.route_name,
                    start_location: route.start_location,
                    end_location: route.end_location,
                    total_stops: orderedStops.length
                },
                stops: orderedStops
            });
        } catch (error) {
            console.error("Fetch driver route error:", error);
            res.status(500).json({ success: false, message: "Unable to load route details." });
        }
    });

    // ==========================================
    // 5. DIESEL RECORDS
    // ==========================================
    router.get("/diesel", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment) {
                return res.json({
                    success: true,
                    assigned: false,
                    message: "No bus has been assigned to you yet.",
                    records: []
                });
            }

            const [records] = await db.query(
                `
                SELECT
                    dr.diesel_id,
                    dr.bus_id,
                    b.bus_number,
                    dr.driver_id,
                    d.name AS driver_name,
                    dr.litres,
                    dr.cost,
                    dr.entry_date,
                    dr.notes,
                    dr.created_at
                FROM diesel_records dr
                JOIN buses b ON dr.bus_id = b.bus_id
                JOIN drivers d ON dr.driver_id = d.driver_id
                WHERE dr.bus_id = ?
                ORDER BY dr.entry_date DESC, dr.diesel_id DESC
                `,
                [assignment.bus_id]
            );

            res.json({
                success: true,
                assigned: true,
                bus_id: assignment.bus_id,
                bus_number: assignment.bus_number,
                records: records.map(r => ({
                    id: r.diesel_id,
                    diesel_id: r.diesel_id,
                    bus_id: r.bus_id,
                    bus_number: r.bus_number,
                    litres: Number(r.litres),
                    cost: r.cost ? Number(r.cost) : null,
                    entry_date: r.entry_date,
                    recorded_by: r.driver_name,
                    notes: r.notes || "—"
                }))
            });
        } catch (error) {
            console.error("Fetch diesel records error:", error);
            res.status(500).json({ success: false, message: "Unable to load diesel records." });
        }
    });

    router.post("/diesel", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment) {
                return res.status(400).json({
                    success: false,
                    message: "You must have an assigned bus to record diesel."
                });
            }

            const { litres, cost, notes, entry_date } = req.body;
            const quantity = Number(litres);

            if (!Number.isFinite(quantity) || quantity <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Please enter a valid diesel quantity in litres (must be greater than 0)."
                });
            }

            const entryCost = cost !== undefined && cost !== "" ? Number(cost) : null;
            if (entryCost !== null && (!Number.isFinite(entryCost) || entryCost < 0)) {
                return res.status(400).json({
                    success: false,
                    message: "Please enter a valid cost or leave it empty."
                });
            }

            const recordDate = entry_date ? new Date(entry_date) : new Date();
            const cleanNotes = notes ? String(notes).trim().substring(0, 255) : null;

            const [result] = await db.execute(
                `
                INSERT INTO diesel_records (bus_id, driver_id, litres, cost, entry_date, notes)
                VALUES (?, ?, ?, ?, ?, ?)
                `,
                [assignment.bus_id, driver.driver_id, quantity, entryCost, recordDate, cleanNotes]
            );

            const insertedId = result.insertId;

            // Broadcast to Admin and other connected dashboards
            io.emit("dieselRecorded", {
                diesel_id: insertedId,
                bus_id: assignment.bus_id,
                bus_number: assignment.bus_number,
                driver_name: driver.name,
                litres: quantity,
                cost: entryCost,
                entry_date: recordDate
            });

            res.status(201).json({
                success: true,
                message: "Diesel entry saved successfully.",
                entry: {
                    diesel_id: insertedId,
                    bus_number: assignment.bus_number,
                    litres: quantity,
                    cost: entryCost,
                    entry_date: recordDate,
                    notes: cleanNotes
                }
            });
        } catch (error) {
            console.error("Create diesel record error:", error);
            res.status(500).json({ success: false, message: "Unable to save diesel record." });
        }
    });

    // ==========================================
    // 6. ACTIVE TRIP & TRIP CONTROLS
    // ==========================================
    router.get("/active-trip", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment) {
                return res.json({ success: true, active: false, message: "No bus assigned." });
            }

            // Find any active trip for this driver or this bus
            const [trips] = await db.query(
                `
                SELECT
                    t.trip_id,
                    t.bus_id,
                    b.bus_number,
                    b.bus_name,
                    t.driver_id,
                    d.name AS driver_name,
                    t.route_id,
                    r.route_name,
                    r.start_location,
                    r.end_location,
                    t.start_time,
                    t.status
                FROM trips t
                JOIN buses b ON t.bus_id = b.bus_id
                JOIN drivers d ON t.driver_id = d.driver_id
                JOIN routes r ON t.route_id = r.route_id
                WHERE (t.driver_id = ? OR t.bus_id = ?) AND t.status = 'Started'
                ORDER BY t.trip_id DESC
                LIMIT 1
                `,
                [driver.driver_id, assignment.bus_id]
            );

            if (trips.length === 0) {
                return res.json({ success: true, active: false });
            }

            const trip = trips[0];

            // Fetch stop progress for this trip
            const [stopProgress] = await db.query(
                `
                SELECT
                    rs.stop_order,
                    s.stop_id,
                    s.stop_name,
                    s.location AS landmark,
                    s.distance_km,
                    s.latitude,
                    s.longitude,
                    COALESCE(tsp.status, 'upcoming') AS progress_status,
                    tsp.updated_at
                FROM route_stops rs
                JOIN stops s ON rs.stop_id = s.stop_id
                LEFT JOIN trip_stop_progress tsp ON tsp.trip_id = ? AND tsp.stop_id = s.stop_id
                WHERE rs.route_id = ?
                ORDER BY rs.stop_order ASC
                `,
                [trip.trip_id, trip.route_id]
            );

            // Fetch latest live location
            const [locs] = await db.query(
                `
                SELECT latitude, longitude, speed, heading, accuracy, recorded_at
                FROM live_locations
                WHERE trip_id = ?
                ORDER BY location_id DESC
                LIMIT 1
                `,
                [trip.trip_id]
            );

            res.json({
                success: true,
                active: true,
                trip: {
                    trip_id: trip.trip_id,
                    bus_id: trip.bus_id,
                    bus_number: trip.bus_number,
                    driver_id: trip.driver_id,
                    driver_name: trip.driver_name,
                    route_id: trip.route_id,
                    route_name: trip.route_name,
                    start_location: trip.start_location,
                    end_location: trip.end_location,
                    start_time: trip.start_time,
                    status: trip.status,
                    stops: stopProgress,
                    last_location: locs.length > 0 ? locs[0] : null
                }
            });
        } catch (error) {
            console.error("Fetch active trip error:", error);
            res.status(500).json({ success: false, message: "Unable to check active trip status." });
        }
    });

    // START TRIP
    router.post("/trips/start", async (req, res) => {
        let connection;
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment) {
                return res.status(400).json({
                    success: false,
                    message: "You cannot start a trip because no bus is currently assigned to you."
                });
            }

            if (!assignment.route_id) {
                return res.status(400).json({
                    success: false,
                    message: "Your assigned bus has no route configured. Please contact the Transportation Admin."
                });
            }

            connection = await db.getConnection();
            await connection.beginTransaction();

            // Check if there is already an active trip for this driver or this bus
            const [existingTrips] = await connection.execute(
                `
                SELECT trip_id, bus_id, driver_id
                FROM trips
                WHERE (driver_id = ? OR bus_id = ?) AND status = 'Started'
                FOR UPDATE
                `,
                [driver.driver_id, assignment.bus_id]
            );

            if (existingTrips.length > 0) {
                await connection.rollback();
                return res.status(409).json({
                    success: false,
                    trip_id: existingTrips[0].trip_id,
                    message: "There is already an active trip running for this bus or driver. Please end the current trip first."
                });
            }

            // Create new trip
            const [insertResult] = await connection.execute(
                `
                INSERT INTO trips (bus_id, driver_id, route_id, start_time, status)
                VALUES (?, ?, ?, NOW(), 'Started')
                `,
                [assignment.bus_id, driver.driver_id, assignment.route_id]
            );

            const tripId = insertResult.insertId;

            // Initialize trip_stop_progress for all stops on this route
            const [routeStops] = await connection.execute(
                `SELECT stop_id FROM route_stops WHERE route_id = ? ORDER BY stop_order ASC`,
                [assignment.route_id]
            );

            for (const rs of routeStops) {
                await connection.execute(
                    `
                    INSERT INTO trip_stop_progress (trip_id, stop_id, status, updated_at)
                    VALUES (?, ?, 'upcoming', NOW())
                    ON DUPLICATE KEY UPDATE status = 'upcoming', updated_at = NOW()
                    `,
                    [tripId, rs.stop_id]
                );
            }

            // Update bus status to Active
            await connection.execute(
                "UPDATE buses SET status = 'Active' WHERE bus_id = ?",
                [assignment.bus_id]
            );

            await connection.commit();

            // Broadcast Socket.IO events to Admin & Student Dashboards
            const tripPayload = {
                trip_id: tripId,
                bus_id: assignment.bus_id,
                bus_number: assignment.bus_number,
                driver_id: driver.driver_id,
                driver_name: driver.name,
                route_id: assignment.route_id,
                route_name: assignment.route_name,
                start_time: new Date().toISOString(),
                status: "Started"
            };

            io.emit("tripStarted", tripPayload);
            io.emit("busesUpdated");
            await broadcastStatistics();

            // Automatically persist Trip-Start Notification for students on this bus/route
            const notifTitle = "Bus Trip Started";
            const notifMsg = `Campus Bus ${assignment.bus_number} on ${assignment.route_name} has started its trip.`;
            await db.execute(
                `INSERT INTO notifications (user_role, user_id, bus_id, route_id, title, message, type, sender_role, sender_id, created_at)
                 VALUES ('student', 0, ?, ?, ?, ?, 'TRIP', 'driver', ?, NOW())`,
                [assignment.bus_id, assignment.route_id, notifTitle, notifMsg, driver.driver_id]
            ).catch(err => console.warn("Trip notification insert skipped:", err.message));

            // Also record notification for Admin
            await db.execute(
                `INSERT INTO notifications (user_role, user_id, bus_id, route_id, title, message, type, sender_role, sender_id, created_at)
                 VALUES ('admin', 1, ?, ?, ?, ?, 'TRIP', 'driver', ?, NOW())`,
                [assignment.bus_id, assignment.route_id, notifTitle, `Driver ${driver.name} started trip for Bus ${assignment.bus_number} (${assignment.route_name}).`, driver.driver_id]
            ).catch(err => console.warn("Admin trip notification insert skipped:", err.message));

            io.emit("newNotification", {
                title: notifTitle,
                message: notifMsg,
                bus_id: assignment.bus_id,
                route_id: assignment.route_id,
                sender_role: "driver",
                created_at: new Date().toISOString()
            });

            res.status(201).json({
                success: true,
                message: "Trip started successfully. GPS tracking is now active.",
                trip: tripPayload
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("Start trip error:", error);
            res.status(500).json({ success: false, message: error.message || "Failed to start trip." });
        } finally {
            if (connection) connection.release();
        }
    });

    // END TRIP
    router.post("/trips/end", async (req, res) => {
        let connection;
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            connection = await db.getConnection();
            await connection.beginTransaction();

            // Locate active trip owned by driver
            const [trips] = await connection.execute(
                `
                SELECT trip_id, bus_id, route_id, start_time
                FROM trips
                WHERE driver_id = ? AND status = 'Started'
                FOR UPDATE
                `,
                [driver.driver_id]
            );

            if (trips.length === 0) {
                await connection.rollback();
                return res.status(404).json({
                    success: false,
                    message: "No active trip found to end."
                });
            }

            const trip = trips[0];
            const endTime = new Date();

            // Update trip status
            await connection.execute(
                `UPDATE trips SET status = 'Completed', end_time = ? WHERE trip_id = ?`,
                [endTime, trip.trip_id]
            );

            // Mark any remaining upcoming stops as completed
            await connection.execute(
                `UPDATE trip_stop_progress SET status = 'completed', updated_at = ? WHERE trip_id = ?`,
                [endTime, trip.trip_id]
            );

            await connection.commit();

            // Broadcast Socket.IO events
            const endPayload = {
                trip_id: trip.trip_id,
                bus_id: trip.bus_id,
                driver_id: driver.driver_id,
                end_time: endTime.toISOString(),
                status: "Completed"
            };

            io.emit("tripEnded", endPayload);
            io.emit("busesUpdated");
            await broadcastStatistics();

            res.json({
                success: true,
                message: "Trip completed successfully.",
                trip: endPayload
            });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            console.error("End trip error:", error);
            res.status(500).json({ success: false, message: error.message || "Failed to end trip." });
        } finally {
            if (connection) connection.release();
        }
    });

    // ==========================================
    // 7. LIVE GPS TRACKING
    // ==========================================
    router.post("/location", async (req, res) => {
        try {
            const driver = req.driver;
            const { latitude, longitude, speed, heading, accuracy } = req.body;

            const lat = Number(latitude);
            const lng = Number(longitude);

            if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid GPS coordinates."
                });
            }

            // Verify active trip for driver
            const [trips] = await db.query(
                `SELECT trip_id, bus_id, route_id FROM trips WHERE driver_id = ? AND status = 'Started' LIMIT 1`,
                [driver.driver_id]
            );

            if (trips.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Cannot submit location because there is no active trip running."
                });
            }

            const trip = trips[0];
            const recordedAt = new Date();

            // Save to MySQL live_locations
            await db.execute(
                `
                INSERT INTO live_locations (trip_id, bus_id, latitude, longitude, speed, heading, accuracy, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    trip.trip_id,
                    trip.bus_id,
                    lat,
                    lng,
                    Number.isFinite(Number(speed)) ? Number(speed) : null,
                    Number.isFinite(Number(heading)) ? Number(heading) : null,
                    Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
                    recordedAt
                ]
            );

            // Automatic Stop Proximity Detection:
            // Check if coordinates are within 250m of any upcoming stop on this route
            try {
                const [stops] = await db.query(
                    `
                    SELECT s.stop_id, s.stop_name, s.latitude, s.longitude, tsp.status AS current_status
                    FROM route_stops rs
                    JOIN stops s ON rs.stop_id = s.stop_id
                    LEFT JOIN trip_stop_progress tsp ON tsp.trip_id = ? AND tsp.stop_id = s.stop_id
                    WHERE rs.route_id = ? AND (tsp.status = 'upcoming' OR tsp.status IS NULL)
                      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
                    `,
                    [trip.trip_id, trip.route_id]
                );

                for (const st of stops) {
                    const dist = getDistanceMeters(lat, lng, st.latitude, st.longitude);
                    if (dist <= 250) {
                        // Reached stop!
                        await db.execute(
                            `
                            INSERT INTO trip_stop_progress (trip_id, stop_id, status, updated_at)
                            VALUES (?, ?, 'reached', NOW())
                            ON DUPLICATE KEY UPDATE status = 'reached', updated_at = NOW()
                            `,
                            [trip.trip_id, st.stop_id]
                        );

                        io.emit("stopProgressUpdated", {
                            trip_id: trip.trip_id,
                            stop_id: st.stop_id,
                            stop_name: st.stop_name,
                            status: "reached",
                            updated_at: new Date().toISOString()
                        });
                        break;
                    }
                }
            } catch (proxErr) {
                console.warn("Proximity detection warning:", proxErr.message);
            }

            // Broadcast real-time location to Admin Dashboard and Student Dashboards
            const locationPayload = {
                bus_id: trip.bus_id,
                trip_id: trip.trip_id,
                driver_id: driver.driver_id,
                latitude: lat,
                longitude: lng,
                speed: Number(speed) || 0,
                heading: Number(heading) || 0,
                accuracy: Number(accuracy) || 0,
                recorded_at: recordedAt.toISOString()
            };

            io.emit("busLocationUpdated", locationPayload);

            res.json({
                success: true,
                message: "Location recorded and broadcast successfully.",
                data: locationPayload
            });
        } catch (error) {
            console.error("Submit location error:", error);
            res.status(500).json({ success: false, message: "Unable to record location." });
        }
    });

    // ==========================================
    // 8. STOP PROGRESS MANUAL ACTION
    // ==========================================
    router.post("/stop-progress", async (req, res) => {
        try {
            const driver = req.driver;
            const { stop_id, status } = req.body;
            const stopId = Number(stop_id);

            if (!Number.isInteger(stopId) || stopId <= 0) {
                return res.status(400).json({ success: false, message: "Invalid stop ID." });
            }

            if (!["reached", "completed"].includes(status)) {
                return res.status(400).json({ success: false, message: "Status must be 'reached' or 'completed'." });
            }

            // Verify active trip for driver
            const [trips] = await db.query(
                `SELECT trip_id, route_id FROM trips WHERE driver_id = ? AND status = 'Started' LIMIT 1`,
                [driver.driver_id]
            );

            if (trips.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "There is no active trip running."
                });
            }

            const trip = trips[0];

            // Verify stop is on this route
            const [stopCheck] = await db.query(
                `SELECT rs.route_stop_id, s.stop_name FROM route_stops rs JOIN stops s ON rs.stop_id = s.stop_id WHERE rs.route_id = ? AND rs.stop_id = ?`,
                [trip.route_id, stopId]
            );

            if (stopCheck.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "This stop does not belong to the route of your active trip."
                });
            }

            const stopName = stopCheck[0].stop_name;

            await db.execute(
                `
                INSERT INTO trip_stop_progress (trip_id, stop_id, status, updated_at)
                VALUES (?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE status = ?, updated_at = NOW()
                `,
                [trip.trip_id, stopId, status, status]
            );

            const progressPayload = {
                trip_id: trip.trip_id,
                stop_id: stopId,
                stop_name: stopName,
                status: status,
                updated_at: new Date().toISOString()
            };

            io.emit("stopProgressUpdated", progressPayload);

            res.json({
                success: true,
                message: `Stop marked as ${status}.`,
                progress: progressPayload
            });
        } catch (error) {
            console.error("Update stop progress error:", error);
            res.status(500).json({ success: false, message: "Unable to update stop progress." });
        }
    });

    // ==========================================
    // 9. DRIVER NOTIFICATIONS & BUS ANNOUNCEMENTS
    // ==========================================
    router.get("/notifications", async (req, res) => {
        try {
            const driver = req.driver;
            const [notifications] = await db.query(
                `
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
                WHERE (user_role = 'driver' AND (user_id = ? OR user_id = 0))
                   OR (sender_role = 'driver' AND sender_id = ?)
                ORDER BY created_at DESC
                LIMIT 50
                `,
                [driver.driver_id, driver.driver_id]
            );

            const unreadCount = notifications.filter(n => !n.is_read && n.sender_role !== 'driver').length;

            res.json({
                success: true,
                notifications,
                unread_count: unreadCount
            });
        } catch (error) {
            console.error("Fetch driver notifications error:", error);
            res.status(500).json({ success: false, message: "Unable to load driver notifications." });
        }
    });

    router.post("/notifications", async (req, res) => {
        try {
            const driver = req.driver;
            const assignment = await getDriverBusAndRoute(db, driver.driver_id);

            if (!assignment || !assignment.bus_id) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot post bus announcements because you do not have an active bus assigned."
                });
            }

            const { title, message } = req.body || {};
            const cleanTitle = String(title || `Bus ${assignment.bus_number} Transit Notice`).trim().slice(0, 120);
            const cleanMessage = String(message || "").trim().slice(0, 500);

            if (!cleanMessage) {
                return res.status(400).json({
                    success: false,
                    message: "Please enter announcement message content."
                });
            }

            // 1. Deliver to assigned students (bus_id / route_id)
            const [studentNotif] = await db.execute(
                `INSERT INTO notifications (user_role, user_id, bus_id, route_id, title, message, type, sender_role, sender_id, created_at)
                 VALUES ('student', 0, ?, ?, ?, ?, 'BUS_UPDATE', 'driver', ?, NOW())`,
                [assignment.bus_id, assignment.route_id, cleanTitle, cleanMessage, driver.driver_id]
            );

            // 2. Also record for Admin dashboard
            await db.execute(
                `INSERT INTO notifications (user_role, user_id, bus_id, route_id, title, message, type, sender_role, sender_id, created_at)
                 VALUES ('admin', 1, ?, ?, ?, ?, 'BUS_UPDATE', 'driver', ?, NOW())`,
                [
                    assignment.bus_id,
                    assignment.route_id,
                    cleanTitle,
                    `Driver ${driver.name} (Bus ${assignment.bus_number}): ${cleanMessage}`,
                    driver.driver_id
                ]
            );

            io.emit("newNotification", {
                notification_id: studentNotif.insertId,
                title: cleanTitle,
                message: cleanMessage,
                bus_id: assignment.bus_id,
                bus_number: assignment.bus_number,
                route_id: assignment.route_id,
                sender_role: "driver",
                sender_name: driver.name,
                created_at: new Date().toISOString()
            });

            res.status(201).json({
                success: true,
                message: "Bus notice delivered to assigned students and Admin successfully.",
                bus_number: assignment.bus_number
            });
        } catch (error) {
            console.error("Create driver notification error:", error);
            res.status(500).json({ success: false, message: "Unable to send notification." });
        }
    });

    router.patch("/notifications/:id/read", async (req, res) => {
        try {
            const notifId = Number(req.params.id);
            await db.execute("UPDATE notifications SET is_read = 1 WHERE notification_id = ?", [notifId]);
            res.json({ success: true, message: "Notification marked as read." });
        } catch (error) {
            console.error("Driver mark notification read error:", error);
            res.status(500).json({ success: false, message: "Unable to update notification." });
        }
    });

    router.patch("/notifications/read-all", async (req, res) => {
        try {
            const driver = req.driver;
            await db.execute(
                "UPDATE notifications SET is_read = 1 WHERE (user_role = 'driver' AND (user_id = ? OR user_id = 0)) OR (sender_role = 'driver' AND sender_id = ?)",
                [driver.driver_id, driver.driver_id]
            );
            res.json({ success: true, message: "All notifications marked as read." });
        } catch (error) {
            console.error("Driver mark all notifications read error:", error);
            res.status(500).json({ success: false, message: "Unable to update notifications." });
        }
    });

    // Mount router on /api/driver
    app.use("/api/driver", router);
}

module.exports = { registerDriverRoutes };
