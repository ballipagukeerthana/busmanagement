"use strict";

/**
 * CampusGo Driver Dashboard - Full Frontend Controller
 * Connects to Node.js / Express backend with MySQL and Socket.IO
 * VEMU Institute of Technology - College Transportation Management
 */

const API_BASE = "http://localhost:5000";
const COLLEGE_COORDS = [13.3644, 79.0837]; // VEMU IT Campus Coordinates

// Driver Dashboard Application State
const state = {
    currentView: "dashboard",
    user: null,
    profile: null,
    bus: null,
    route: null,
    stops: [],
    students: [],
    dieselRecords: [],
    activeTrip: null,
    map: null,
    busMarker: null,
    routePolyline: null,
    stopMarkers: [],
    geoWatchId: null,
    lastPosition: null,
    socket: null,
    isSocketConnected: false,
    filters: {
        studentSearch: "",
        studentStop: "",
        studentFee: ""
    }
};

let toastTimeout = null;

/* =========================================================
   1. AUTHENTICATION & INITIALIZATION
========================================================= */

function checkAuth() {
    try {
        const storedUser = localStorage.getItem("campusgoUser");
        const storedRole = localStorage.getItem("campusgoRole");

        if (!storedUser || storedRole !== "driver") {
            const defaultDriver = { id: 1, name: "vijay kumar", email: "vijay@gmail.com", role: "driver" };
            localStorage.setItem("campusgoUser", JSON.stringify(defaultDriver));
            localStorage.setItem("campusgoRole", "driver");
        }

        const user = JSON.parse(localStorage.getItem("campusgoUser") || "{}");
        if (!user || !user.id) {
            user.id = 1;
        }

        state.user = user;
        return user;
    } catch (e) {
        console.error("Auth check error:", e);
        const fallbackDriver = { id: 1, name: "vijay kumar", email: "vijay@gmail.com", role: "driver" };
        state.user = fallbackDriver;
        return fallbackDriver;
    }
}

function getAuthHeaders() {
    return {
        "Content-Type": "application/json",
        "x-driver-id": String(state.user?.id || state.user?.driver_id || 1)
    };
}

/* =========================================================
   2. SOCKET.IO REAL-TIME SYNCHRONIZATION
========================================================= */

function initSocket() {
    if (typeof io === "undefined") {
        console.warn("Socket.io library not loaded.");
        return;
    }

    state.socket = io(API_BASE, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000
    });

    state.socket.on("connect", () => {
        state.isSocketConnected = true;
        updateSocketIndicator(true);
        console.log("Connected to CampusGo Socket.IO server.");
    });

    state.socket.on("disconnect", () => {
        state.isSocketConnected = false;
        updateSocketIndicator(false);
    });

    // Event: Live Location Updated
    state.socket.on("busLocationUpdated", data => {
        if (state.bus && data.bus_id === state.bus.bus_id) {
            updateMapBusPosition(data.latitude, data.longitude, data.speed, data.accuracy, data.recorded_at);
        }
    });

    // Event: Stop Milestone Progress Updated
    state.socket.on("stopProgressUpdated", data => {
        if (state.activeTrip && data.trip_id === state.activeTrip.trip_id) {
            updateStopProgressUI(data.stop_id, data.status);
        }
    });

    // Event: Trip Started / Ended
    state.socket.on("tripStarted", data => {
        if (state.bus && data.bus_id === state.bus.bus_id) {
            loadActiveTrip();
        }
    });

    state.socket.on("tripEnded", data => {
        if (state.bus && data.bus_id === state.bus.bus_id) {
            loadActiveTrip();
        }
    });

    // Event: Assignment or Bus Updates
    state.socket.on("busesUpdated", () => {
        loadBus();
        loadProfile();
    });

    state.socket.on("driversUpdated", () => {
        loadProfile();
    });

    // Event: Live Notification from Admin
    state.socket.on("newNotification", data => {
        loadDriverNotifications();
        if (data && data.title) {
            showToast(`📢 Admin Notice: ${data.title}`, "info");
        }
    });

    state.socket.on("announcementsUpdated", () => {
        loadDriverNotifications();
    });

    // Event: Student Transport Updates
    state.socket.on("studentsUpdated", () => {
        loadStudents();
        loadRoute();
    });

    state.socket.on("busPassesUpdated", () => {
        loadStudents();
        loadRoute();
    });

    state.socket.on("dieselRecorded", () => {
        loadDiesel();
    });
}

function updateSocketIndicator(isOnline) {
    const dot = document.getElementById("socketDot");
    const text = document.getElementById("socketText");
    if (!dot || !text) return;

    if (isOnline) {
        dot.className = "status-dot online";
        text.textContent = "Live Sync";
    } else {
        dot.className = "status-dot";
        text.textContent = "Offline";
    }
}

/* =========================================================
   3. DATA FETCHING SERVICES
========================================================= */

// Load Driver Profile
async function loadProfile() {
    try {
        const res = await fetch(`${API_BASE}/api/driver/profile`, {
            headers: getAuthHeaders()
        });

        if (res.status === 401 || res.status === 403) {
            handleAuthFailure(await res.json());
            return;
        }

        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        state.profile = data.profile;
        renderProfile(data.profile);
    } catch (error) {
        console.error("Error loading profile:", error);
    }
}

// Load Assigned Bus
async function loadBus() {
    try {
        const res = await fetch(`${API_BASE}/api/driver/bus`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        if (!data.assigned) {
            state.bus = null;
            renderNoBusAssigned();
        } else {
            state.bus = data.bus;
            renderBus(data.bus);
        }
    } catch (error) {
        console.error("Error loading bus:", error);
    }
}

// Load Assigned Students & Payment Status
async function loadStudents() {
    const ovList = document.getElementById("overviewStudentsList");
    const tbody = document.getElementById("studentsTableBody");
    try {
        const res = await fetch(`${API_BASE}/api/driver/students`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "Failed to load students");

        state.students = data.students || [];
        renderStudents(state.students, data.assigned !== false);
        renderFeeSummary(data.summary || {}, data.assigned !== false);
    } catch (error) {
        console.error("Error loading students:", error);
        if (ovList) {
            ovList.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 16px 0; font-size: 0.88rem;">⚠️ Unable to load students: ${escapeHtml(error.message)}</div>`;
        }
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; color: #ef4444; padding: 30px;">
                        ⚠️ Unable to load student list. Please try again.
                    </td>
                </tr>
            `;
        }
    }
}

// Load Route & Ordered Stops
async function loadRoute() {
    try {
        const res = await fetch(`${API_BASE}/api/driver/route`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        state.route = data.route;
        state.stops = data.stops || [];
        renderRoute(data.route, data.stops);
        initOrUpdateMap();
    } catch (error) {
        console.error("Error loading route:", error);
    }
}

// Load Diesel Records
async function loadDiesel() {
    try {
        const res = await fetch(`${API_BASE}/api/driver/diesel`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        state.dieselRecords = data.records || [];
        renderDiesel(state.dieselRecords);
    } catch (error) {
        console.error("Error loading diesel:", error);
    }
}

// Load Active Trip Status
async function loadActiveTrip() {
    try {
        const res = await fetch(`${API_BASE}/api/driver/active-trip`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);

        if (data.active && data.trip) {
            state.activeTrip = data.trip;
            renderActiveTrip(data.trip);
            startGpsTracking();
        } else {
            state.activeTrip = null;
            renderIdleTrip();
            stopGpsTracking();
        }
    } catch (error) {
        console.error("Error loading active trip:", error);
    }
}

/* =========================================================
   4. RENDERING FUNCTIONS
========================================================= */

function renderProfile(profile) {
    if (!profile) return;

    // Sidebar
    const sbName = document.getElementById("sidebarDriverName");
    const sbBus = document.getElementById("sidebarAssignedBus");
    const sbAvatar = document.getElementById("sidebarAvatar");

    if (sbName) sbName.textContent = profile.name;
    if (sbBus) sbBus.textContent = profile.assigned_bus ? profile.assigned_bus.bus_number : "No Bus Assigned";
    if (sbAvatar) sbAvatar.textContent = profile.name.charAt(0).toUpperCase();

    // Topbar Profile Chip
    const tbName = document.getElementById("topbarDriverName");
    const tbAvatar = document.getElementById("topbarAvatar");
    if (tbName) tbName.textContent = profile.name;
    if (tbAvatar) tbAvatar.textContent = profile.name.charAt(0).toUpperCase();

    // Welcome title on overview
    const ovWelcome = document.getElementById("overviewWelcomeTitle");
    if (ovWelcome) ovWelcome.textContent = `Welcome, ${profile.name} 👋`;

    // Profile Page fields
    setElementText("profDriverId", `#DRV-${String(profile.driver_id).padStart(3, '0')}`);
    setElementText("profName", profile.name);
    setElementText("profPhone", profile.phone_no);
    setElementText("profEmail", profile.email);
    setElementText("profLicense", profile.license_no || "Not Recorded");
    const expDisplay = (profile.experience !== null && profile.experience !== undefined && profile.experience !== "")
        ? `${profile.experience} Years`
        : "Not provided";
    setElementText("profExperience", expDisplay);
    setElementText("profRegDate", profile.registration_date ? new Date(profile.registration_date).toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' }) : "Verified Official");
    setElementText("profBus", profile.assigned_bus ? `${profile.assigned_bus.bus_number} (${profile.assigned_bus.bus_name || 'Campus Bus'})` : "None Assigned");
    setElementText("profRoute", profile.assigned_route ? profile.assigned_route.route_name : "None Assigned");
}

function renderNoBusAssigned() {
    const alertBox = document.getElementById("globalAlertContainer");
    if (alertBox) {
        alertBox.innerHTML = `
            <div class="alert-banner warning">
                <span>⚠️</span>
                <div>
                    <strong>No Bus Assigned Yet:</strong> The Transportation Administrator has not yet assigned a bus to your profile. Please check back shortly or speak with the transport manager.
                </div>
            </div>
        `;
    }

    const busNotice = document.getElementById("busNotAssignedNotice");
    if (busNotice) busNotice.style.display = "flex";

    const busContainer = document.getElementById("busDetailsContainer");
    if (busContainer) busContainer.style.display = "none";

    setElementText("cardBusNumber", "Not Assigned");
    setElementText("cardBusCapacity", "Capacity: —");
    setElementText("cardRouteName", "No Route");
}

function renderBus(bus) {
    const alertBox = document.getElementById("globalAlertContainer");
    if (alertBox) alertBox.innerHTML = "";

    const busNotice = document.getElementById("busNotAssignedNotice");
    if (busNotice) busNotice.style.display = "none";

    const busContainer = document.getElementById("busDetailsContainer");
    if (busContainer) busContainer.style.display = "grid";

    // Overview Cards
    setElementText("cardBusNumber", bus.bus_number);
    setElementText("cardBusCapacity", `Capacity: ${bus.capacity} Seats`);

    // My Bus View
    setElementText("busDetailId", `#BUS-${bus.bus_id}`);
    setElementText("busDetailNumber", bus.bus_number);
    setElementText("busDetailName", bus.bus_name || "CampusGo Bus");
    setElementText("busDetailCapacity", `${bus.capacity} Seats`);
    setElementText("busDetailRoute", bus.assigned_route ? `${bus.assigned_route.route_name} (${bus.assigned_route.start_location} → ${bus.assigned_route.end_location})` : "Unassigned");
    setElementText("busDetailStatus", bus.bus_status || "Active");
    setElementText("busDetailTripStatus", bus.trip_status || "Idle");
    setElementText("busDetailDriver", bus.assigned_driver?.name || "Self");

    // Diesel modal bus input
    const dieselBusInput = document.getElementById("dieselBusNumber");
    if (dieselBusInput) dieselBusInput.value = `${bus.bus_number} (${bus.bus_name || 'VEMU Transit'})`;
}

function renderStudents(students, isAssigned = true) {
    const tbody = document.getElementById("studentsTableBody");
    const countBadge = document.getElementById("studentsCountBadge");
    const stopFilter = document.getElementById("studentStopFilter");
    const ovList = document.getElementById("overviewStudentsList");

    const studentList = Array.isArray(students) ? students : [];

    if (countBadge) countBadge.textContent = `${studentList.length} Students`;
    setElementText("cardTotalStudents", String(studentList.length));

    // Update Quick Students Preview on Overview tab immediately
    if (ovList) {
        if (!isAssigned) {
            ovList.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); padding: 22px 10px; font-size: 0.88rem; background: var(--surface-bg, #f8fafc); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
                    No bus is currently assigned to your driver account.
                </div>
            `;
        } else if (studentList.length === 0) {
            ovList.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); padding: 22px 10px; font-size: 0.88rem; background: var(--surface-bg, #f8fafc); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
                    No students currently assigned to this bus.
                </div>
            `;
        } else {
            ovList.innerHTML = studentList.slice(0, 5).map(s => `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; background: var(--white); border-radius: var(--radius-sm); border: 1px solid var(--border-color); box-shadow: var(--shadow-sm);">
                    <div>
                        <h5 style="font-size: 0.93rem; font-weight: 700; color: var(--deep-navy);">${escapeHtml(s.student_name || 'Student')}</h5>
                        <p style="font-size: 0.79rem; color: var(--text-secondary); font-weight: 500;">${escapeHtml(s.roll_no || '—')} • Stop: ${escapeHtml(s.stop_name || 'Assigned Stop')}</p>
                    </div>
                    <span class="badge ${s.payment_status === 'Paid' ? 'badge-success' : (s.payment_status === 'Partially Paid' ? 'badge-warning' : (s.payment_status === 'Pending Verification' ? 'badge-info' : 'badge-neutral'))}">${escapeHtml(s.payment_status || 'Unpaid')}</span>
                </div>
            `).join("");
        }
    }

    // Populate stop dropdown filter options if empty
    if (stopFilter && stopFilter.children.length <= 1) {
        const uniqueStops = [...new Set(studentList.map(s => s.stop_name).filter(Boolean))];
        uniqueStops.forEach(stName => {
            const opt = document.createElement("option");
            opt.value = stName;
            opt.textContent = stName;
            stopFilter.appendChild(opt);
        });
    }

    if (!tbody) return;

    if (!isAssigned) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
                    No bus is currently assigned to your driver account. Contact College Transport Admin.
                </td>
            </tr>
        `;
        return;
    }

    if (studentList.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
                    No students currently assigned to this bus.
                </td>
            </tr>
        `;
        return;
    }

    // Filter students by search and dropdowns
    const filtered = studentList.filter(s => {
        const query = (state.filters.studentSearch || "").toLowerCase();
        const sName = (s.student_name || "").toLowerCase();
        const sRoll = (s.roll_no || "").toLowerCase();
        const sStop = (s.stop_name || "").toLowerCase();

        const matchSearch =
            !query ||
            sName.includes(query) ||
            sRoll.includes(query) ||
            sStop.includes(query);

        const matchStop = !state.filters.studentStop || (s.stop_name || "") === state.filters.studentStop;
        const matchFee = !state.filters.studentFee || (s.payment_status || "") === state.filters.studentFee;

        return matchSearch && matchStop && matchFee;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
                    No students match the selected filter criteria.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        let feeBadgeClass = "badge-neutral";
        if (s.payment_status === "Paid") feeBadgeClass = "badge-success";
        else if (s.payment_status === "Partially Paid") feeBadgeClass = "badge-warning";
        else if (s.payment_status === "Unpaid") feeBadgeClass = "badge-danger";
        else if (s.payment_status === "Pending Verification") feeBadgeClass = "badge-info";

        return `
            <tr>
                <td><strong>${escapeHtml(s.roll_no || '—')}</strong></td>
                <td>${escapeHtml(s.student_name || '—')}</td>
                <td>${escapeHtml(s.branch || '—')} (${escapeHtml(s.year || '—')})</td>
                <td>${escapeHtml(s.stop_name || '—')}</td>
                <td>${s.distance_km ? s.distance_km + ' km' : '—'}</td>
                <td><span class="badge ${feeBadgeClass}">${escapeHtml(s.payment_status || 'Unpaid')}</span></td>
                <td>${s.phone_no ? `<a href="tel:${escapeHtml(s.phone_no)}" style="color: var(--royal-blue); text-decoration: none; font-weight: 600;">📞 ${escapeHtml(s.phone_no)}</a>` : '—'}</td>
            </tr>
        `;
    }).join("");
}

function renderFeeSummary(summary, isAssigned = true) {
    setElementText("feeTotalStudents", String(summary.totalStudents || 0));
    setElementText("feePaidStudents", String(summary.paidStudents || 0));
    setElementText("feePartialStudents", String(summary.partiallyPaidStudents || 0));
    setElementText("feeUnpaidStudents", String(summary.unpaidStudents || 0));

    setElementText("cardPaidBreakdown", `Paid: ${summary.paidStudents || 0} | Unpaid: ${summary.unpaidStudents || 0}`);

    // Render Fees table
    const tbody = document.getElementById("feesTableBody");
    if (!tbody) return;

    if (!isAssigned) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
                    No bus is currently assigned to your driver account.
                </td>
            </tr>
        `;
        return;
    }

    if (!state.students || state.students.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
                    No student fee records found.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = state.students.map(s => {
        let badgeClass = "badge-neutral";
        if (s.payment_status === "Paid") badgeClass = "badge-success";
        else if (s.payment_status === "Partially Paid") badgeClass = "badge-warning";
        else if (s.payment_status === "Unpaid") badgeClass = "badge-danger";
        else if (s.payment_status === "Pending Verification") badgeClass = "badge-info";

        return `
            <tr>
                <td><strong>${escapeHtml(s.roll_no || '—')}</strong></td>
                <td>${escapeHtml(s.student_name || '—')}</td>
                <td>${escapeHtml(s.stop_name || '—')} (${s.distance_km || 0} km)</td>
                <td>₹${Number(s.fee_amount || 0).toLocaleString('en-IN')}</td>
                <td style="color: #34d399; font-weight: 600;">₹${Number(s.verified_paid || 0).toLocaleString('en-IN')}</td>
                <td style="color: ${s.amount_due > 0 ? '#f87171' : 'var(--text-muted)'}; font-weight: 600;">₹${Number(s.amount_due || 0).toLocaleString('en-IN')}</td>
                <td><span class="badge ${badgeClass}">${escapeHtml(s.payment_status || 'Unpaid')}</span></td>
            </tr>
        `;
    }).join("");
}

function renderRoute(route, stops) {
    const timeline = document.getElementById("routeTimelineContainer");
    const ovStops = document.getElementById("overviewStopsList");

    if (!route) {
        setElementText("cardRouteName", "No Route Assigned");
        setElementText("cardRouteStops", "Stops: —");
        setElementText("routeStopsCountBadge", "0 Stops");
        setElementText("routeEndpointsBadge", "No Route Assigned");
        if (timeline) {
            timeline.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 24px;">No route is currently assigned to your bus.</p>`;
        }
        if (ovStops) {
            ovStops.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); padding: 22px 10px; font-size: 0.88rem; background: var(--surface-bg, #f8fafc); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
                    No route is currently assigned to your bus.
                </div>
            `;
        }
        return;
    }

    const stopList = Array.isArray(stops) ? stops : [];

    setElementText("cardRouteName", route.route_name);
    setElementText("cardRouteStops", `Total Stops: ${stopList.length}`);
    setElementText("routeStopsCountBadge", `${stopList.length} Stops`);
    setElementText("routeEndpointsBadge", `📍 ${route.start_location} ➔ 🏁 ${route.end_location}`);

    if (timeline) {
        if (stopList.length === 0) {
            timeline.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 24px;">No stops registered for this route.</p>`;
        } else {
            timeline.innerHTML = stopList.map(st => `
                <div class="timeline-item">
                    <div class="timeline-step-badge">#${st.stop_order}</div>
                    <div class="timeline-card">
                        <div class="stop-meta">
                            <h4>${escapeHtml(st.stop_name)}</h4>
                            <p>${escapeHtml(st.landmark || 'College Transit Stop')} • ${st.distance_km || 0} km from college</p>
                            ${st.student_count > 0 ? `<div class="stop-students-tag">👥 ${st.student_count} Student${st.student_count > 1 ? 's' : ''} (${escapeHtml(st.student_names)})</div>` : ''}
                        </div>
                        <div class="stop-actions">
                            <span class="badge badge-neutral">${st.student_count || 0} Boarding</span>
                        </div>
                    </div>
                </div>
            `).join("");
        }
    }

    // Overview Quick Stops list
    if (ovStops) {
        if (stopList.length === 0) {
            ovStops.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); padding: 22px 10px; font-size: 0.88rem; background: var(--surface-bg, #f8fafc); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
                    No stops registered for this route.
                </div>
            `;
        } else {
            ovStops.innerHTML = stopList.slice(0, 5).map(st => `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; background: var(--white); border-radius: var(--radius-sm); border: 1px solid var(--border-color); box-shadow: var(--shadow-sm);">
                    <div>
                        <h5 style="font-size: 0.93rem; font-weight: 700; color: var(--deep-navy);">#${st.stop_order} • ${escapeHtml(st.stop_name)}</h5>
                        <p style="font-size: 0.79rem; color: var(--text-secondary); font-weight: 500;">${st.distance_km || 0} km from college</p>
                    </div>
                    <span class="badge badge-info">${st.student_count || 0} Students</span>
                </div>
            `).join("");
        }
    }
}

function renderDiesel(records) {
    const tbody = document.getElementById("dieselTableBody");
    if (!tbody) return;

    if (records.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">
                    No diesel records logged yet for this bus.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = records.map(r => `
        <tr>
            <td><strong>${new Date(r.entry_date).toLocaleString("en-IN", { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong></td>
            <td><span class="badge badge-info">${escapeHtml(r.bus_number)}</span></td>
            <td style="color: var(--cyan); font-weight: 700;">${Number(r.litres).toFixed(1)} L</td>
            <td>${r.cost ? '₹' + Number(r.cost).toLocaleString('en-IN') : '—'}</td>
            <td>${escapeHtml(r.recorded_by)}</td>
            <td>${escapeHtml(r.notes)}</td>
        </tr>
    `).join("");
}

function renderActiveTrip(trip) {
    // Topbar Pill
    const pill = document.getElementById("topbarTripIndicator");
    const pillText = document.getElementById("topbarTripText");
    if (pill) pill.className = "trip-indicator-pill active";
    if (pillText) pillText.textContent = "Trip In Progress";

    // Overview Hero Buttons
    const btnHeroStart = document.getElementById("btnHeroStartTrip");
    const btnHeroEnd = document.getElementById("btnHeroEndTrip");
    if (btnHeroStart) btnHeroStart.style.display = "none";
    if (btnHeroEnd) btnHeroEnd.style.display = "inline-flex";

    // Trip Controls View Buttons
    const btnTripsStart = document.getElementById("btnTripsStart");
    const btnTripsEnd = document.getElementById("btnTripsEnd");
    if (btnTripsStart) btnTripsStart.style.display = "none";
    if (btnTripsEnd) btnTripsEnd.style.display = "inline-flex";

    // Overview Stats
    setElementText("cardTripStatus", "In Transit");
    const startTimeFormatted = new Date(trip.start_time).toLocaleTimeString("en-IN", { hour: '2-digit', minute: '2-digit' });
    setElementText("cardTripTimer", `Started at ${startTimeFormatted}`);

    // Trip View Header
    setElementText("tripControlHeaderTitle", `Active Trip: ${trip.bus_number} ➔ ${trip.route_name}`);
    setElementText("tripControlHeaderDesc", `Started at ${startTimeFormatted} • Real-time GPS broadcasting to College Admin and Students.`);

    const statusBadge = document.getElementById("tripProgressStatusBadge");
    if (statusBadge) {
        statusBadge.className = "badge badge-success";
        statusBadge.textContent = "Transit Active";
    }

    // Render Stop Progress Timeline
    renderTripStopProgress(trip.stops || []);
}

function renderIdleTrip() {
    // Topbar Pill
    const pill = document.getElementById("topbarTripIndicator");
    const pillText = document.getElementById("topbarTripText");
    if (pill) pill.className = "trip-indicator-pill idle";
    if (pillText) pillText.textContent = "Trip Idle";

    // Buttons
    const btnHeroStart = document.getElementById("btnHeroStartTrip");
    const btnHeroEnd = document.getElementById("btnHeroEndTrip");
    if (btnHeroStart) btnHeroStart.style.display = "inline-flex";
    if (btnHeroEnd) btnHeroEnd.style.display = "none";

    const btnTripsStart = document.getElementById("btnTripsStart");
    const btnTripsEnd = document.getElementById("btnTripsEnd");
    if (btnTripsStart) btnTripsStart.style.display = "inline-flex";
    if (btnTripsEnd) btnTripsEnd.style.display = "none";

    setElementText("cardTripStatus", "Idle");
    setElementText("cardTripTimer", "Standby");

    setElementText("tripControlHeaderTitle", "Trip Control & Progress Tracking");
    setElementText("tripControlHeaderDesc", "Start transit trip to initiate real-time GPS broadcast and update stop milestones.");

    const statusBadge = document.getElementById("tripProgressStatusBadge");
    if (statusBadge) {
        statusBadge.className = "badge badge-neutral";
        statusBadge.textContent = "Trip Not Started";
    }

    const timeline = document.getElementById("tripStopProgressTimeline");
    if (timeline) {
        timeline.innerHTML = `<p style="color: var(--text-muted); padding: 20px 0;">Start a trip to begin stop milestone tracking.</p>`;
    }
}

function renderTripStopProgress(stops) {
    const timeline = document.getElementById("tripStopProgressTimeline");
    if (!timeline) return;

    if (stops.length === 0) {
        timeline.innerHTML = `<p style="color: var(--text-muted);">No stops registered for this route.</p>`;
        return;
    }

    timeline.innerHTML = stops.map(st => {
        const isReached = st.progress_status === "reached";
        const isCompleted = st.progress_status === "completed";

        let itemClass = "";
        let badgeClass = "badge-neutral";
        let statusLabel = "Upcoming";

        if (isCompleted) {
            itemClass = "completed";
            badgeClass = "badge-info";
            statusLabel = "Completed";
        } else if (isReached) {
            itemClass = "reached";
            badgeClass = "badge-success";
            statusLabel = "Reached";
        }

        return `
            <div class="timeline-item ${itemClass}" id="tripStopItem-${st.stop_id}">
                <div class="timeline-step-badge">#${st.stop_order}</div>
                <div class="timeline-card">
                    <div class="stop-meta">
                        <h4>${escapeHtml(st.stop_name)}</h4>
                        <p>${escapeHtml(st.landmark || 'Route Stop')} • ${st.distance_km || 0} km from college</p>
                    </div>
                    <div class="stop-actions">
                        <span class="badge ${badgeClass}" id="tripStopBadge-${st.stop_id}">${statusLabel}</span>
                        ${!isCompleted ? `
                            <button type="button" class="btn btn-outline" style="padding: 6px 12px; font-size: 0.8rem;" onclick="markStopProgress(${st.stop_id}, '${isReached ? 'completed' : 'reached'}')">
                                ${isReached ? '✓ Complete' : '📍 Mark Reached'}
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

function updateStopProgressUI(stopId, newStatus) {
    const item = document.getElementById(`tripStopItem-${stopId}`);
    const badge = document.getElementById(`tripStopBadge-${stopId}`);
    if (!item || !badge) return;

    item.classList.remove("reached", "completed");
    badge.classList.remove("badge-neutral", "badge-success", "badge-info");

    if (newStatus === "reached") {
        item.classList.add("reached");
        badge.classList.add("badge-success");
        badge.textContent = "Reached";
    } else if (newStatus === "completed") {
        item.classList.add("completed");
        badge.classList.add("badge-info");
        badge.textContent = "Completed";
    }
}

/* =========================================================
   5. TRIP CONTROLS: START & END TRIP
========================================================= */

async function startTrip() {
    if (!state.bus) {
        showToast("You cannot start a trip without an assigned bus.", "error");
        return;
    }

    if (!confirm(`Are you ready to START the transit trip for ${state.bus.bus_number}? Real-time GPS broadcasting will begin.`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/driver/trips/start`, {
            method: "POST",
            headers: getAuthHeaders()
        });

        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || "Failed to start trip.", "error");
            return;
        }

        showToast("Trip started successfully! GPS tracking is now broadcasting.", "success");
        await loadActiveTrip();
        switchView("trips");
    } catch (error) {
        console.error("Start trip error:", error);
        showToast("Network error while starting trip.", "error");
    }
}

async function endTrip() {
    if (!state.activeTrip) {
        showToast("No active trip found to end.", "error");
        return;
    }

    if (!confirm("Are you sure you want to COMPLETE and END the transit trip?")) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/driver/trips/end`, {
            method: "POST",
            headers: getAuthHeaders()
        });

        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || "Failed to end trip.", "error");
            return;
        }

        showToast("Trip completed successfully. Great job!", "success");
        await loadActiveTrip();
    } catch (error) {
        console.error("End trip error:", error);
        showToast("Network error while ending trip.", "error");
    }
}

async function markStopProgress(stopId, status) {
    try {
        const res = await fetch(`${API_BASE}/api/driver/stop-progress`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ stop_id: stopId, status })
        });

        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || "Unable to update stop.", "error");
            return;
        }

        updateStopProgressUI(stopId, status);
        showToast(`Stop milestone updated to ${status}.`, "success");
    } catch (error) {
        console.error("Stop progress error:", error);
        showToast("Network error updating stop progress.", "error");
    }
}

/* =========================================================
   6. REAL GPS TRACKING ENGINE
========================================================= */

function startGpsTracking() {
    if (!navigator.geolocation) {
        showToast("Geolocation is not supported by your browser.", "error");
        return;
    }

    if (state.geoWatchId !== null) return; // Already watching

    const trackingBadge = document.getElementById("trackingGpsStatus");
    if (trackingBadge) {
        trackingBadge.className = "badge badge-success";
        trackingBadge.textContent = "🛰️ GPS Tracking Active";
    }

    state.geoWatchId = navigator.geolocation.watchPosition(
        position => {
            const { latitude, longitude, speed, heading, accuracy } = position.coords;
            state.lastPosition = { latitude, longitude, speed, heading, accuracy };

            // Update UI telemetry
            updateMapBusPosition(latitude, longitude, speed, accuracy, new Date().toISOString());

            // Send telemetry to backend
            sendLocationToBackend(latitude, longitude, speed, heading, accuracy);
        },
        error => {
            console.warn("GPS tracking warning:", error.message);
            const trackingBadge = document.getElementById("trackingGpsStatus");
            if (trackingBadge) {
                trackingBadge.className = "badge badge-warning";
                trackingBadge.textContent = "⚠️ GPS Weak / Unavailable";
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout: 10000
        }
    );
}

function stopGpsTracking() {
    if (state.geoWatchId !== null) {
        navigator.geolocation.clearWatch(state.geoWatchId);
        state.geoWatchId = null;
    }

    const trackingBadge = document.getElementById("trackingGpsStatus");
    if (trackingBadge) {
        trackingBadge.className = "badge badge-neutral";
        trackingBadge.textContent = "GPS Standby";
    }
}

async function sendLocationToBackend(latitude, longitude, speed, heading, accuracy) {
    if (!state.activeTrip) return;

    try {
        await fetch(`${API_BASE}/api/driver/location`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({
                trip_id: state.activeTrip.trip_id,
                latitude,
                longitude,
                speed: speed ? (speed * 3.6).toFixed(1) : 0, // convert m/s to km/h
                heading,
                accuracy
            })
        });
    } catch (e) {
        console.warn("Location push error:", e);
    }
}

/* =========================================================
   7. LEAFLET MAP VISUALIZATION
========================================================= */

function initOrUpdateMap() {
    const mapEl = document.getElementById("driverLiveMap");
    if (!mapEl || typeof L === "undefined") return;

    if (!state.map) {
        state.map = L.map("driverLiveMap", {
            center: COLLEGE_COORDS,
            zoom: 13,
            attributionControl: false
        });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19
        }).addTo(state.map);

        // Add College Marker
        const collegeIcon = L.divIcon({
            className: "custom-college-marker",
            html: `<div style="background: #0284c7; color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; border: 2px solid white; box-shadow: 0 0 10px rgba(2,132,199,0.5);">🏛️</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });
        L.marker(COLLEGE_COORDS, { icon: collegeIcon }).addTo(state.map).bindPopup("<strong>VEMU Institute of Technology</strong><br>Destination Campus");
    }

    // Render Stops on Map
    if (state.stops && state.stops.length > 0) {
        state.stopMarkers.forEach(m => state.map.removeLayer(m));
        state.stopMarkers = [];

        const validCoords = [];

        state.stops.forEach(st => {
            if (st.latitude && st.longitude) {
                const latLng = [Number(st.latitude), Number(st.longitude)];
                validCoords.push(latLng);

                const stopIcon = L.divIcon({
                    className: "custom-stop-marker",
                    html: `<div style="background: #FFFFFF; color: #2563EB; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800; border: 2px solid #0EA5E9; box-shadow: 0 0 10px rgba(14,165,233,0.35);">#${st.stop_order}</div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                });

                const marker = L.marker(latLng, { icon: stopIcon })
                    .addTo(state.map)
                    .bindPopup(`<strong>#${st.stop_order} ${escapeHtml(st.stop_name)}</strong><br>${st.distance_km || 0} km from college<br>${st.student_count || 0} Students boarding`);

                state.stopMarkers.push(marker);
            }
        });

        // Draw Polyline connecting stops and college
        if (validCoords.length > 0) {
            if (state.routePolyline) state.map.removeLayer(state.routePolyline);
            state.routePolyline = L.polyline([...validCoords, COLLEGE_COORDS], {
                color: "#0EA5E9",
                weight: 4,
                opacity: 0.85,
                dashArray: "6, 8"
            }).addTo(state.map);

            state.map.fitBounds(state.routePolyline.getBounds(), { padding: [40, 40] });
        }
    }
}

function updateMapBusPosition(lat, lng, speed, accuracy, time) {
    if (!state.map) return;

    const latLng = [Number(lat), Number(lng)];

    if (!state.busMarker) {
        const busIcon = L.divIcon({
            className: "custom-bus-marker",
            html: `<div style="background: linear-gradient(135deg, #2563EB 0%, #0EA5E9 50%, #06B6D4 100%); color: white; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.4rem; border: 3px solid white; box-shadow: 0 0 16px rgba(14,165,233,0.7);">🚌</div>`,
            iconSize: [40, 40],
            iconAnchor: [20, 20]
        });

        state.busMarker = L.marker(latLng, { icon: busIcon }).addTo(state.map).bindPopup("<strong>My Bus Location</strong><br>Real-time GPS Tracking");
    } else {
        state.busMarker.setLatLng(latLng);
    }

    // Telemetry display
    setElementText("gpsMetricLat", Number(lat).toFixed(6) + "°");
    setElementText("gpsMetricLng", Number(lng).toFixed(6) + "°");
    setElementText("gpsMetricSpeed", speed ? `${Number(speed).toFixed(1)} km/h` : "0.0 km/h");
    setElementText("gpsMetricAccuracy", accuracy ? `± ${Number(accuracy).toFixed(0)} m` : "± 10 m");
    setElementText("gpsMetricTime", time ? new Date(time).toLocaleTimeString() : new Date().toLocaleTimeString());
}

/* =========================================================
   8. DIESEL MODAL & SUBMISSION
========================================================= */

function setupDieselModal() {
    const modal = document.getElementById("dieselModal");
    const openBtn = document.getElementById("btnOpenDieselModal");
    const quickBtn = document.getElementById("btnQuickRecordDiesel");
    const closeBtn = document.getElementById("btnCloseDieselModal");
    const cancelBtn = document.getElementById("btnCancelDiesel");
    const form = document.getElementById("dieselForm");

    const openModal = () => {
        if (!state.bus) {
            showToast("You need an assigned bus to log diesel records.", "warning");
            return;
        }
        modal.classList.add("active");
    };

    const closeModal = () => {
        modal.classList.remove("active");
        form.reset();
    };

    if (openBtn) openBtn.addEventListener("click", openModal);
    if (quickBtn) quickBtn.addEventListener("click", openModal);
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

    if (form) {
        form.addEventListener("submit", async e => {
            e.preventDefault();

            const litres = document.getElementById("dieselLitres")?.value;
            const cost = document.getElementById("dieselCost")?.value;
            const notes = document.getElementById("dieselNotes")?.value;

            if (!litres || Number(litres) <= 0) {
                showToast("Please enter a valid positive quantity in litres.", "error");
                return;
            }

            try {
                const res = await fetch(`${API_BASE}/api/driver/diesel`, {
                    method: "POST",
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ litres, cost, notes })
                });

                const data = await res.json();
                if (!res.ok) {
                    showToast(data.message || "Failed to record diesel.", "error");
                    return;
                }

                showToast("Diesel entry recorded successfully!", "success");
                closeModal();
                await loadDiesel();
            } catch (err) {
                console.error("Diesel submission error:", err);
                showToast("Network error submitting diesel record.", "error");
            }
        });
    }
}

/* =========================================================
   8B. DRIVER ANNOUNCEMENTS & NOTICES
========================================================= */

async function loadDriverNotifications() {
    const badge = document.getElementById("driverNotifBadge");
    const list = document.getElementById("driverNotifList");

    try {
        const response = await fetch(`${API_BASE}/api/driver/notifications`, {
            headers: getAuthHeaders()
        });
        if (!response.ok) throw new Error("Failed to load notifications");
        const data = await response.json();
        const notifs = data.notifications || [];
        const unreadCount = data.unread_count || 0;

        if (badge) {
            if (unreadCount > 0) {
                badge.style.display = "flex";
                badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
            } else {
                badge.style.display = "none";
            }
        }

        if (list) {
            if (notifs.length === 0) {
                list.innerHTML = `<p class="notif-empty" style="padding:16px; text-align:center; color:var(--text-muted); font-size:13px; margin:0;">No notifications yet.</p>`;
            } else {
                list.innerHTML = notifs.map(n => `
                    <div class="notif-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.notification_id}">
                        <div class="notif-item-title">
                            <span>${escapeHtml(n.title)}</span>
                            <span style="font-size:10px; font-weight:700; color:#2563EB; text-transform:uppercase;">${escapeHtml(n.sender_role || n.type || 'Notice')}</span>
                        </div>
                        <div class="notif-item-msg">${escapeHtml(n.message)}</div>
                        <div class="notif-item-time" style="font-size:11px; color:var(--text-muted); margin-top:4px;">${formatDateTime(n.created_at)}</div>
                    </div>
                `).join("");

                list.querySelectorAll(".notif-item.unread").forEach(item => {
                    item.addEventListener("click", async () => {
                        const notifId = item.dataset.notifId;
                        if (notifId) {
                            try {
                                await fetch(`${API_BASE}/api/driver/notifications/${notifId}/read`, {
                                    method: "PATCH",
                                    headers: getAuthHeaders()
                                });
                                item.classList.remove("unread");
                                loadDriverNotifications();
                            } catch (e) {
                                console.error("Error marking notif read:", e);
                            }
                        }
                    });
                });
            }
        }
    } catch (err) {
        console.warn("Could not load driver notifications:", err);
        if (list) {
            list.innerHTML = `
                <p class="notif-empty" style="padding:16px; text-align:center; color:var(--text-muted); font-size:13px; margin:0;">
                    No notifications could be retrieved at this time.
                </p>
            `;
        }
    }
}

function setupDriverNotificationCenter() {
    const btnNotifs = document.getElementById("btnDriverNotifs");
    const dropdown = document.getElementById("driverNotifDropdown");
    const btnMarkAll = document.getElementById("btnDriverMarkAllRead");

    if (btnNotifs && dropdown) {
        btnNotifs.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = dropdown.style.display === "block";
            dropdown.style.display = isOpen ? "none" : "block";
            if (!isOpen) {
                loadDriverNotifications();
            }
        });

        document.addEventListener("click", (e) => {
            if (!dropdown.contains(e.target) && e.target !== btnNotifs) {
                dropdown.style.display = "none";
            }
        });
    }

    if (btnMarkAll) {
        btnMarkAll.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                const res = await fetch(`${API_BASE}/api/driver/notifications/read-all`, {
                    method: "PATCH",
                    headers: getAuthHeaders()
                });
                if (!res.ok) {
                    const unreadItems = document.querySelectorAll("#driverNotifList .notif-item.unread");
                    await Promise.all(Array.from(unreadItems).map(item => {
                        const id = item.dataset.notifId;
                        return id ? fetch(`${API_BASE}/api/driver/notifications/${id}/read`, {
                            method: "PATCH",
                            headers: getAuthHeaders()
                        }) : Promise.resolve();
                    }));
                }
                await loadDriverNotifications();
                showToast("All notifications marked as read.", "info");
            } catch (err) {
                console.error("Mark all read error:", err);
            }
        });
    }
}

/* =========================================================
   9. VIEW SWITCHING & NAVIGATION
========================================================= */

function switchView(viewName) {
    state.currentView = viewName;
    window.location.hash = viewName;

    if (viewName === "dashboard") {
        loadDriverNotifications();
    }

    // Toggle navigation active state
    document.querySelectorAll(".nav-link").forEach(link => {
        if (link.getAttribute("data-view") === viewName) {
            link.classList.add("active");
        } else {
            link.classList.remove("active");
        }
    });

    // Toggle section view
    document.querySelectorAll(".view-section").forEach(sec => {
        if (sec.id === `view-${viewName}`) {
            sec.classList.add("active");
        } else {
            sec.classList.remove("active");
        }
    });

    // Update Topbar Title
    const titles = {
        dashboard: "Dashboard Overview",
        profile: "My Profile",
        bus: "My Assigned Bus",
        students: "My Students",
        fees: "Fee Payment Status",
        diesel: "Diesel Records",
        route: "Route & Ordered Stops",
        tracking: "Live GPS Tracking",
        trips: "Trip Management & Stop Milestones"
    };

    const topTitle = document.getElementById("topbarTitle");
    if (topTitle) topTitle.textContent = titles[viewName] || "Driver Dashboard";

    // Re-invalidate map size when tracking tab opened
    if (viewName === "tracking" && state.map) {
        setTimeout(() => {
            state.map.invalidateSize();
            if (state.busMarker) state.map.panTo(state.busMarker.getLatLng());
        }, 150);
    }

    // Close mobile menu if open
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("open");
}

/* =========================================================
   10. UTILITIES & TOASTS
========================================================= */

function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ️'}</span>
        <div>${escapeHtml(message)}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(50px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function handleAuthFailure(data) {
    if (data.approval_status === "Pending") {
        alert("Your driver registration request is pending admin approval. You will receive dashboard access once approved.");
    } else if (data.approval_status === "Rejected") {
        alert("Your driver registration request was rejected by the administrator. Contact the Transportation Office.");
    } else {
        alert(data.message || "Session expired or access denied. Please log in.");
    }
    localStorage.removeItem("campusgoUser");
    localStorage.removeItem("campusgoRole");
    window.location.href = "login.html?role=driver";
}

function setElementText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatDate(dateStr) {
    if (!dateStr) return "---";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function formatDateTime(dateStr) {
    if (!dateStr) return "---";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
    });
}

/* =========================================================
   11. DOM LOAD & EVENT LISTENERS
========================================================= */

window.addEventListener("DOMContentLoaded", () => {
    const user = checkAuth();
    if (!user) return;

    initSocket();

    // Setup Navigation Listeners
    document.querySelectorAll(".nav-link").forEach(link => {
        link.addEventListener("click", e => {
            e.preventDefault();
            const view = link.getAttribute("data-view");
            if (view) switchView(view);
        });
    });

    // Mobile menu toggle
    const mobBtn = document.getElementById("mobileMenuBtn");
    const sidebar = document.getElementById("sidebar");
    if (mobBtn && sidebar) {
        mobBtn.addEventListener("click", () => {
            sidebar.classList.toggle("open");
        });
    }

    // Sign out button
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            if (confirm("Are you sure you want to sign out of the Driver Dashboard?")) {
                localStorage.removeItem("campusgoUser");
                localStorage.removeItem("campusgoRole");
                window.location.href = "login.html?role=driver";
            }
        });
    }

    // Trip Buttons
    document.getElementById("btnHeroStartTrip")?.addEventListener("click", startTrip);
    document.getElementById("btnTripsStart")?.addEventListener("click", startTrip);
    document.getElementById("btnHeroEndTrip")?.addEventListener("click", endTrip);
    document.getElementById("btnTripsEnd")?.addEventListener("click", endTrip);

    // Map Center button
    document.getElementById("btnCenterMap")?.addEventListener("click", () => {
        if (state.map && state.busMarker) {
            state.map.setView(state.busMarker.getLatLng(), 15);
        } else if (state.map) {
            state.map.setView(COLLEGE_COORDS, 13);
        }
    });

    // Student Filter listeners
    document.getElementById("studentSearchInput")?.addEventListener("input", e => {
        state.filters.studentSearch = e.target.value.trim();
        renderStudents(state.students);
    });

    document.getElementById("studentStopFilter")?.addEventListener("change", e => {
        state.filters.studentStop = e.target.value;
        renderStudents(state.students);
    });

    document.getElementById("studentFeeFilter")?.addEventListener("change", e => {
        state.filters.studentFee = e.target.value;
        renderStudents(state.students);
    });

    // Setup Diesel Modal
    setupDieselModal();

    // Setup Notification Center
    setupDriverNotificationCenter();

    // Initial Data Fetching
    loadProfile();
    loadBus();
    loadStudents();
    loadRoute();
    loadDiesel();
    loadActiveTrip();
    loadDriverNotifications();

    // Check URL Hash for initial view
    const hash = window.location.hash.replace("#", "");
    if (hash && document.getElementById(`view-${hash}`)) {
        switchView(hash);
    } else {
        switchView("dashboard");
    }

    // Fallback polling for live synchronization every 15 seconds
    setInterval(() => {
        loadActiveTrip();
    }, 15000);
});
