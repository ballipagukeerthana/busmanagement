"use strict";

/**
 * CampusGo Admin Dashboard - Full Client Controller
 * Connects to MySQL Backend REST APIs and Socket.IO
 */

const API_BASE = "http://localhost:5000";

// Default college coordinates: VEMU IT (P.Kothakota, Chittoor, Andhra Pradesh)
const COLLEGE_COORDS = [13.3644, 79.0837];

// Application state
const state = {
    currentView: "dashboard",
    searchQuery: "",
    stats: {},
    driverRequests: [],
    students: [],
    drivers: [],
    buses: [],
    routes: [],
    selectedRouteId: null,
    selectedRouteData: null,
    feeAssignments: [],
    payments: [],
    passRequests: [],
    busPasses: [],
    liveBuses: [],
    reports: null,
    cancellations: [],
    dieselRecords: [],
    dieselStats: {},
    notifications: [],
    contactMessages: [],
    recipients: { routes: [], buses: [] },
    filters: {
        requests: "All",
        studentsFee: "All",
        studentsRoute: "",
        studentsBus: "",
        driversStatus: "All",
        busesCondition: "All",
        paymentsStatus: "All",
        passRequestsStatus: "All",
        cancellationsStatus: "All",
        dieselBus: "All"
    },
    map: null,
    mapMarkers: {},
    activePass: null,
    activePayment: null
};

let toastTimer = null;
let socket = null;
let isSocketConnected = false;

/* =========================================================
   UTILITIES & FORMATTERS
========================================================= */

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function money(value) {
    return "₹" + Number(value || 0).toLocaleString("en-IN");
}

function formatDate(dateVal) {
    if (!dateVal) return "N/A";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function formatDateTime(dateVal) {
    if (!dateVal) return "N/A";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function showToast(message, type = "info") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.className = "toast";
    }, 4000);
}

function getBadge(status) {
    const s = String(status || "").trim();
    const map = {
        "Paid": "ok",
        "Success": "ok",
        "Approved": "ok",
        "Active": "ok",
        "Working": "ok",
        "Available": "ok",
        "Partially Paid": "warn",
        "Pending": "warn",
        "Pending Verification": "warn",
        "Maintenance": "warn",
        "Started": "warn",
        "Unpaid": "bad",
        "Rejected": "bad",
        "Failed": "bad",
        "Not working": "bad",
        "Inactive": "muted",
        "Completed": "muted",
        "Idle": "muted"
    };
    return `<span class="badge ${map[s] || 'muted'}">${esc(s || 'Unknown')}</span>`;
}

async function apiFetch(endpoint, options = {}) {
    try {
        let fetchOptions = { ...options };
        if (fetchOptions.body && typeof fetchOptions.body === "object" && !(fetchOptions.body instanceof FormData)) {
            fetchOptions.body = JSON.stringify(fetchOptions.body);
        }
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...fetchOptions,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || `API error (${response.status})`);
        }
        return data;
    } catch (err) {
        console.error(`Fetch error at ${endpoint}:`, err);
        throw err;
    }
}

/* =========================================================
   AUTH CHECK & ADMIN PROFILE
========================================================= */

function checkAuth() {
    try {
        const userStr = localStorage.getItem("campusgoUser");
        const role = localStorage.getItem("campusgoRole");

        if (!userStr || role !== "admin") {
            // If running without pre-login during testing, set default admin session
            const defaultAdmin = { id: 1, name: "System Administrator", email: "admin@campusgo.com", role: "admin" };
            localStorage.setItem("campusgoUser", JSON.stringify(defaultAdmin));
            localStorage.setItem("campusgoRole", "admin");
        }

        const user = JSON.parse(localStorage.getItem("campusgoUser") || "{}");
        const adminNameEl = document.getElementById("adminName");
        const avatarEl = document.querySelector(".avatar");

        if (adminNameEl && user.name) {
            adminNameEl.textContent = user.name;
        }
        if (avatarEl && user.name) {
            avatarEl.textContent = user.name.trim().charAt(0).toUpperCase();
        }
    } catch (e) {
        console.warn("Auth check warning:", e);
    }
}

/* =========================================================
   1. DASHBOARD STATISTICS
========================================================= */

async function loadStats(showMessage = false) {
    try {
        const res = await apiFetch("/api/admin/stats");
        if (!res.success) throw new Error("Could not load stats");

        state.stats = res;
        applyStatsToUI(res);

        const dbStatus = document.getElementById("dbStatus");
        const dbIndicator = document.getElementById("dbIndicator");
        const statsStatus = document.getElementById("statsStatus");
        const lastUpdated = document.getElementById("lastUpdated");

        if (dbStatus) dbStatus.textContent = "MySQL connected: database campusgo";
        if (dbIndicator) {
            dbIndicator.textContent = isSocketConnected ? "Live" : "Connected";
            dbIndicator.className = "activity-time success-text";
        }
        if (statsStatus) {
            statsStatus.textContent = isSocketConnected
                ? "Live real-time dashboard active"
                : "Live MySQL database connected";
        }
        if (lastUpdated) {
            lastUpdated.textContent = new Date().toLocaleTimeString("en-IN");
        }

        if (showMessage) showToast("Dashboard statistics updated.", "success");
    } catch (err) {
        console.error("Stats error:", err);
        const dbStatus = document.getElementById("dbStatus");
        const dbIndicator = document.getElementById("dbIndicator");
        if (dbStatus) dbStatus.textContent = "Database connection error";
        if (dbIndicator) {
            dbIndicator.textContent = "Error";
            dbIndicator.className = "activity-time error-text";
        }
        if (showMessage) showToast("Failed to refresh statistics: " + err.message, "error");
    }
}

function applyStatsToUI(data) {
    const mapping = [
        ["totalStudents", data.totalStudents ?? 0],
        ["totalDrivers", data.totalDrivers ?? 0],
        ["totalBuses", data.totalBuses ?? 0],
        ["statAvailableBuses", data.availableBuses ?? 0],
        ["totalRoutes", data.totalRoutes ?? 0],
        ["statPendingDrivers", data.pendingDriverRequests ?? 0],
        ["statPendingPayments", data.pendingPayments ?? 0],
        ["statWorkingBuses", data.workingBuses ?? data.activeBuses ?? 0],
        ["statNotWorkingBuses", data.notWorkingBuses ?? 0],
        ["statPendingPasses", data.pendingPassRequests ?? data.pendingRequests ?? 0],
        ["statTotalPasses", data.totalGeneratedPasses ?? 0]
    ];

    for (const [id, val] of mapping) {
        const el = document.getElementById(id);
        if (el) el.textContent = Number(val).toLocaleString("en-IN");
    }

    // Update navigation badges
    const navPendingDrivers = Number(data.pendingDriverRequests || 0);
    const navPendingPayments = Number(data.pendingPayments || 0);
    const navPendingPasses = Number(data.pendingPassRequests || data.pendingRequests || 0);
    const navUnreadMessages = Number(data.unreadContactMessages || 0);

    const bReq = document.getElementById("navRequests");
    if (bReq) {
        bReq.textContent = navPendingDrivers;
        bReq.hidden = navPendingDrivers === 0;
    }
    const bPay = document.getElementById("navPayments");
    if (bPay) {
        bPay.textContent = navPendingPayments;
        bPay.hidden = navPendingPayments === 0;
    }
    const bPass = document.getElementById("navPassRequests");
    if (bPass) {
        bPass.textContent = navPendingPasses;
        bPass.hidden = navPendingPasses === 0;
    }
    const bMsg = document.getElementById("navMessages");
    if (bMsg) {
        bMsg.textContent = navUnreadMessages;
        bMsg.hidden = navUnreadMessages === 0;
    }

    // Shortcut pills on dashboard
    const pillReq = document.getElementById("pillRequests");
    if (pillReq) {
        pillReq.textContent = navPendingDrivers;
        pillReq.hidden = navPendingDrivers === 0;
    }
    const pillPay = document.getElementById("pillPayments");
    if (pillPay) {
        pillPay.textContent = navPendingPayments;
        pillPay.hidden = navPendingPayments === 0;
    }
}

/* =========================================================
   2. DRIVER REQUESTS
========================================================= */

function formatDriverExperience(exp) {
    if (exp === null || exp === undefined || exp === "" || exp === "Not provided") {
        return "Not provided";
    }
    const num = Number(exp);
    if (!isNaN(num) && Number.isFinite(num)) {
        return `${num} ${num === 1 ? "year" : "years"} experience`;
    }
    return String(exp);
}

async function loadDriverRequests() {
    const container = document.getElementById("view-requests");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading driver registration requests...</div>`;

    try {
        const res = await apiFetch("/api/admin/driver-requests");
        state.driverRequests = res.requests || [];
        renderDriverRequestsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load driver requests: ${esc(err.message)}</div>`;
    }
}

function renderDriverRequestsView() {
    const container = document.getElementById("view-requests");
    if (!container) return;

    const filter = state.filters.requests;
    const query = state.searchQuery.toLowerCase();

    const rows = state.driverRequests.filter(r => {
        const matchesFilter = filter === "All" || r.status === filter;
        const matchesSearch = !query ||
            r.name.toLowerCase().includes(query) ||
            r.phone.toLowerCase().includes(query) ||
            r.email.toLowerCase().includes(query) ||
            r.licence.toLowerCase().includes(query);
        return matchesFilter && matchesSearch;
    });

    const pendingCount = state.driverRequests.filter(r => r.status === "Pending").length;
    const approvedCount = state.driverRequests.filter(r => r.status === "Approved").length;
    const rejectedCount = state.driverRequests.filter(r => r.status === "Rejected").length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Driver Requests</h1>
                <p class="subtitle">Review, verify and approve new driver registrations for VEMU IT CampusGo.</p>
            </div>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${pendingCount}</strong><span>Waiting for approval</span></div>
            <div class="summary-item"><strong>${approvedCount}</strong><span>Approved drivers</span></div>
            <div class="summary-item"><strong>${rejectedCount}</strong><span>Rejected</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Pending", "Approved", "Rejected"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('requests', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} requests shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Driver</th>
                            <th>Phone Number</th>
                            <th>License Number</th>
                            <th>Registered Date</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(r => `
                            <tr>
                                <td>
                                    <strong>${esc(r.name)}</strong>
                                    <small>${esc(r.email)}</small>
                                </td>
                                <td>${esc(r.phone)}</td>
                                <td>
                                    <code>${esc(r.licence)}</code>
                                    <div style="font-size: 11px; color: #64748b; font-weight: 600; margin-top: 2px;">
                                        ⭐ ${formatDriverExperience(r.experience ?? r.years_experience ?? r.experience_years)}
                                    </div>
                                    ${r.license_photo ? `
                                        <div style="margin-top: 6px;">
                                            <a href="${API_BASE}${r.license_photo.startsWith('/') ? '' : '/'}${r.license_photo}?role=admin" target="_blank" rel="noopener" style="display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 11px; font-weight: 700; color: #1e40af; background: #dbeafe; border-radius: 6px; text-decoration: none; border: 1px solid #bfdbfe;">
                                                📄 View Licence
                                            </a>
                                        </div>
                                    ` : `<div style="font-size: 10.5px; color: #94a3b8; margin-top: 3px;">No licence file</div>`}
                                </td>
                                <td>${formatDateTime(r.date)}</td>
                                <td>${getBadge(r.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewDriverRequestDetails(${r.id})">👁️</button>
                                        ${r.status === 'Pending' ? `
                                            <button class="btn-icon btn-icon-success" title="Approve Driver" onclick="openApproveDriverModal(${r.id}, '${esc(r.name)}')">✓</button>
                                            <button class="btn-icon btn-icon-delete" title="Reject Driver" onclick="rejectDriverRequest(${r.id}, '${esc(r.name)}')">✕</button>
                                        ` : ""}
                                        <button class="btn-icon btn-icon-delete" title="Delete Request" onclick="deleteDriverRequest(${r.id}, '${esc(r.name)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="6">No driver requests found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function viewDriverRequestDetails(id) {
    const r = state.driverRequests.find(x => x.id === id);
    if (!r) return;
    openDetailsModal("Driver Request Details", [
        { label: "Request ID", value: `#REQ-${r.id}` },
        { label: "Driver Name", value: r.name },
        { label: "Phone Number", value: r.phone },
        { label: "Email Address", value: r.email },
        { label: "Driving Licence", value: r.licence },
        { label: "Driving Licence Document", value: r.license_photo ? `<a href="${API_BASE}${r.license_photo.startsWith('/') ? '' : '/'}${r.license_photo}?role=admin" target="_blank" rel="noopener" style="color: #2563EB; font-weight: 700; text-decoration: underline; display: inline-flex; align-items: center; gap: 4px;">📄 View Uploaded Licence File</a>` : `<span style="color: #94a3b8;">Not uploaded</span>` },
        { label: "Driving Experience", value: formatDriverExperience(r.experience ?? r.years_experience ?? r.experience_years) },
        { label: "Registration Date", value: formatDateTime(r.date) },
        { label: "Review Date", value: r.reviewed_at ? formatDateTime(r.reviewed_at) : "Pending Review" },
        { label: "Approval Status", value: getBadge(r.status) }
    ]);
}

function openApproveDriverModal(id, name) {
    const dialog = document.getElementById("formDialog");
    const r = state.driverRequests.find(x => x.id === id);
    const expRaw = r ? (r.experience ?? r.years_experience ?? r.experience_years) : undefined;
    const expVal = (expRaw !== null && expRaw !== undefined && expRaw !== "" && expRaw !== "Not provided" && !isNaN(Number(expRaw)))
        ? Number(expRaw)
        : 5;
    document.getElementById("dlgTitle").textContent = `Approve Driver: ${name}`;
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="approve_driver">
        <input type="hidden" name="request_id" value="${id}">
        ${r && r.license_photo ? `
            <div class="field full" style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 12px; color: #1e3a8a; font-weight: 600;">Uploaded Driving Licence:</span>
                <a href="${API_BASE}${r.license_photo.startsWith('/') ? '' : '/'}${r.license_photo}?role=admin" target="_blank" rel="noopener" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; font-weight: 700; color: #ffffff; background: #2563eb; border-radius: 6px; text-decoration: none;">
                    📄 Verify Licence Document
                </a>
            </div>
        ` : ''}
        <div class="field full">
            <label>Monthly Salary (₹)</label>
            <input type="number" name="salary" required min="0" step="500" placeholder="e.g. 18000" value="18000">
        </div>
        <div class="field full">
            <label>Driving Experience (Years)</label>
            <input type="number" name="experience" required min="0" max="60" placeholder="e.g. 5" value="${expVal}">
        </div>
        <div class="field full">
            <p style="font-size: 11px; color: #526079; line-height: 1.5;">
                Upon approval, this driver account will be activated in the official drivers database and can be assigned to campus buses.
            </p>
        </div>
    `;
    dialog.showModal();
}

async function rejectDriverRequest(id, name) {
    if (!confirm(`Are you sure you want to reject the driver application for ${name}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/driver-requests/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: "Rejected" })
        });
        showToast(res.message || "Driver request rejected.", "info");
        await Promise.all([loadDriverRequests(), loadStats()]);
    } catch (err) {
        showToast("Rejection failed: " + err.message, "error");
    }
}

async function deleteDriverRequest(id, name) {
    if (!confirm(`Are you sure you want to delete the registration request for ${name}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/driver-requests/${id}`, { method: "DELETE" });
        showToast(res.message || "Driver request deleted.", "success");
        await Promise.all([loadDriverRequests(), loadStats()]);
    } catch (err) {
        showToast("Delete failed: " + err.message, "error");
    }
}

/* =========================================================
   3. STUDENTS MANAGEMENT
========================================================= */

async function loadStudents() {
    const container = document.getElementById("view-students");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading students transportation records from MySQL...</div>`;

    try {
        const res = await apiFetch("/api/admin/students");
        state.students = res.students || [];
        renderStudentsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load students: ${esc(err.message)}</div>`;
    }
}

function renderStudentsView() {
    const container = document.getElementById("view-students");
    if (!container) return;

    const feeFilter = state.filters.studentsFee;
    const routeFilter = state.filters.studentsRoute;
    const busFilter = state.filters.studentsBus;
    const query = state.searchQuery.toLowerCase();

    // Collect unique routes and buses for filtering dropdowns
    const uniqueRoutes = [...new Set(state.students.map(s => s.route_name).filter(Boolean))];
    const uniqueBuses = [...new Set(state.students.map(s => s.bus_number).filter(Boolean))];

    const rows = state.students.filter(s => {
        const matchesFee = feeFilter === "All" || s.fee_status === feeFilter;
        const matchesRoute = !routeFilter || s.route_name === routeFilter;
        const matchesBus = !busFilter || s.bus_number === busFilter;
        const matchesSearch = !query ||
            (s.name || "").toLowerCase().includes(query) ||
            (s.roll || "").toLowerCase().includes(query) ||
            (s.phone || "").toLowerCase().includes(query) ||
            (s.branch || "").toLowerCase().includes(query) ||
            (s.email || "").toLowerCase().includes(query);
        return matchesFee && matchesRoute && matchesBus && matchesSearch;
    });

    const totalStudents = state.students.length;
    const paidCount = state.students.filter(s => s.fee_status === "Paid").length;
    const unpaidCount = state.students.filter(s => s.fee_status === "Unpaid").length;
    const partialCount = state.students.filter(s => s.fee_status === "Partially Paid").length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Students Management</h1>
                <p class="subtitle">Complete database of registered students with transport and fee assignments.</p>
            </div>
            <button class="btn btn-primary" onclick="openAddStudentModal()">+ Add New Student</button>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${totalStudents}</strong><span>Total Students</span></div>
            <div class="summary-item"><strong>${paidCount}</strong><span>Fee Paid</span></div>
            <div class="summary-item"><strong>${partialCount}</strong><span>Partially Paid</span></div>
            <div class="summary-item"><strong>${unpaidCount}</strong><span>Unpaid</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar" style="flex-wrap: wrap; gap: 12px;">
                <div class="chips">
                    ${["All", "Paid", "Partially Paid", "Unpaid", "Pending Verification"].map(v =>
                        `<button type="button" class="chip ${feeFilter === v ? 'active' : ''}" onclick="setFilter('studentsFee', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <div style="display: flex; gap: 8px; align-items: center; margin-left: auto;">
                    <select onchange="setFilter('studentsRoute', this.value)" style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); font-size: 11px;">
                        <option value="">All Routes</option>
                        ${uniqueRoutes.map(r => `<option value="${esc(r)}" ${routeFilter === r ? 'selected' : ''}>${esc(r)}</option>`).join("")}
                    </select>
                    <select onchange="setFilter('studentsBus', this.value)" style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); font-size: 11px;">
                        <option value="">All Buses</option>
                        ${uniqueBuses.map(b => `<option value="${esc(b)}" ${busFilter === b ? 'selected' : ''}>${esc(b)}</option>`).join("")}
                    </select>
                    <span class="subtitle">${rows.length} shown</span>
                </div>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>Branch / Year</th>
                            <th>Contact Info</th>
                            <th>Assigned Route &amp; Stop</th>
                            <th>Assigned Bus</th>
                            <th>Fee Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(s => `
                            <tr>
                                <td>
                                    <strong>${esc(s.name)}</strong>
                                    <small>${esc(s.roll)}</small>
                                </td>
                                <td>
                                    <strong>${esc(s.branch)}</strong>
                                    <small>${esc(s.year)}</small>
                                </td>
                                <td>
                                    <strong>${esc(s.phone)}</strong>
                                    <small>${esc(s.email)}</small>
                                </td>
                                <td>
                                    <strong>${esc(s.route_name)}</strong>
                                    <small>${esc(s.stop_name)} ${s.distance_km ? `(${s.distance_km} km)` : ''}</small>
                                </td>
                                <td>
                                    <strong>${esc(s.bus_number)}</strong>
                                </td>
                                <td>
                                    ${getBadge(s.fee_status)}
                                    <small style="display:block; margin-top:2px;">Paid: ${money(s.total_paid)} / ${money(s.applicable_fee)}</small>
                                </td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewStudentDetails(${s.student_id})">👁️</button>
                                        <button class="btn-icon btn-icon-edit" title="Edit Student" onclick="openEditStudentModal(${s.student_id})">✏️</button>
                                        <button class="btn-icon btn-icon-delete" title="Deactivate / Delete Student" onclick="deactivateStudent(${s.student_id}, '${esc(s.name)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="7">No matching student records found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

async function viewStudentDetails(studentId) {
    try {
        const res = await apiFetch(`/api/admin/students/${studentId}`);
        const s = res.student;
        openDetailsModal(`Student Profile: ${s.name}`, [
            { label: "Student ID", value: `#STU-${s.student_id}` },
            { label: "Full Name", value: s.name },
            { label: "Roll Number", value: s.roll_no },
            { label: "Branch & Year", value: `${s.branch} — ${s.year}` },
            { label: "Phone Number", value: s.phone_no },
            { label: "Email Address", value: s.email },
            { label: "Residential Address", value: s.residential_address || "Not specified" },
            { label: "Account Status", value: getBadge(s.status) },
            { label: "Assigned Route", value: s.route_name || "Unassigned" },
            { label: "Pickup Stop", value: `${s.stop_name || 'Unassigned'} (${s.distance_km || 0} km from college)` },
            { label: "Assigned Bus", value: s.bus_number || "Unassigned" },
            { label: "Applicable Transportation Fee", value: money(s.applicable_fee) },
            { label: "Total Amount Paid", value: money(s.total_paid) },
            { label: "Outstanding Balance", value: money(s.outstanding_amount) },
            { label: "Recent Payments", value: (s.payments && s.payments.length) ? s.payments.map(p => `${money(p.amount)} (${p.payment_status} - ${p.transaction_id || 'N/A'})`).join("<br>") : "No payments recorded" },
            { label: "Bus Passes Issued", value: (s.passes && s.passes.length) ? s.passes.map(p => `${p.pass_number} (${p.status})`).join("<br>") : "None" }
        ]);
    } catch (err) {
        showToast("Could not load student profile: " + err.message, "error");
    }
}

async function openAddStudentModal() {
    try {
        const [routesRes, busesRes] = await Promise.all([
            apiFetch("/api/routes").catch(() => ({ routes: [] })),
            apiFetch("/api/buses").catch(() => ({ buses: [] }))
        ]);
        const routes = routesRes.routes || [];
        const buses = busesRes.buses || [];

        const dialog = document.getElementById("formDialog");
        document.getElementById("dlgTitle").textContent = "Add New Student";
        document.getElementById("dlgBody").innerHTML = `
            <input type="hidden" name="action_type" value="add_student">
            <input type="hidden" name="bus_id" id="modalStudentBusId" value="">
            <div class="field full">
                <label for="adminStudentName">Full Name <span style="color:#e11d48;">*</span></label>
                <input type="text" id="adminStudentName" name="name" required placeholder="Enter your full name">
            </div>
            <div class="field">
                <label for="adminStudentBranch">Branch / Program <span style="color:#e11d48;">*</span></label>
                <select id="adminStudentBranch" name="branch" required onchange="updateModalStudentYearOptions()">
                    <option value="">Select Branch / Program</option>
                    <option value="CSE">CSE</option>
                    <option value="CSE (IT)">CSE (IT)</option>
                    <option value="CSE (AI)">CSE (AI)</option>
                    <option value="CSE (AI & ML)">CSE (AI & ML)</option>
                    <option value="ECE">ECE</option>
                    <option value="EEE">EEE</option>
                    <option value="Civil">Civil</option>
                    <option value="Mechanical">Mechanical</option>
                    <option value="Diploma">Diploma</option>
                    <option value="BBA">BBA</option>
                    <option value="MBA">MBA</option>
                    <option value="Pharmacy">Pharmacy</option>
                </select>
            </div>
            <div class="field">
                <label for="adminStudentYear">Year <span style="color:#e11d48;">*</span></label>
                <select id="adminStudentYear" name="year" required>
                    <option value="">Select Year</option>
                </select>
            </div>
            <div class="field">
                <label for="adminStudentRoll">Roll Number <span style="color:#e11d48;">*</span></label>
                <input type="text" id="adminStudentRoll" name="roll_no" required placeholder="Enter 10-character roll number" minlength="10" maxlength="10" pattern="[A-Za-z0-9]{10}">
                <small style="color:var(--text-muted); font-size:11px; margin-top:3px;">Roll number must contain exactly 10 letters or numbers.</small>
            </div>
            <div class="field">
                <label for="adminStudentPhone">Phone Number <span style="color:#e11d48;">*</span></label>
                <input type="tel" id="adminStudentPhone" name="phone_no" required placeholder="Enter 10-digit phone number" maxlength="10" pattern="[0-9]{10}">
            </div>
            <div class="field full">
                <label for="adminStudentEmail">Email <span style="color:#e11d48;">*</span></label>
                <input type="email" id="adminStudentEmail" name="email" required placeholder="Enter your email">
            </div>
            <div class="field full">
                <label for="adminResidentialAddress">Residential Address <span style="color:#e11d48;">*</span></label>
                <textarea id="adminResidentialAddress" name="residential_address" rows="3" maxlength="255" placeholder="Enter your house address, village/town and area" required style="width:100%; border:1px solid var(--border); border-radius:9px; padding:10px;"></textarea>
            </div>
            <div class="field">
                <label for="modalRouteSelect">Select Route <span style="color:#e11d48;">*</span></label>
                <select name="route_id" id="modalRouteSelect" required onchange="onModalRouteChange(this.value)">
                    <option value="">Select Route</option>
                    ${routes.map(r => {
                        let busId = "";
                        if (r.bus_number && buses.length) {
                            const match = buses.find(b => (b.bus_number || "").toUpperCase() === (r.bus_number || "").toUpperCase());
                            if (match) busId = match.bus_id;
                        }
                        return `<option value="${r.route_id}" data-bus-id="${busId}">${esc(r.route_name)} (${esc(r.bus_number || 'Bus')})</option>`;
                    }).join("")}
                </select>
            </div>
            <div class="field">
                <label for="modalStopSelect">Select Pickup Point <span style="color:#e11d48;">*</span></label>
                <select name="stop_id" id="modalStopSelect" required>
                    <option value="">Select a route first</option>
                </select>
                <small style="color:var(--text-muted); font-size:11px; margin-top:3px;">Pickup points depend on the selected route.</small>
            </div>
            <div class="field">
                <label for="adminStudentPassword">Password <span style="color:#e11d48;">*</span></label>
                <input type="password" id="adminStudentPassword" name="password" required minlength="8" placeholder="Create a password">
            </div>
            <div class="field">
                <label for="adminStudentConfirmPassword">Confirm Password <span style="color:#e11d48;">*</span></label>
                <input type="password" id="adminStudentConfirmPassword" name="confirm_password" required minlength="8" placeholder="Confirm your password">
            </div>
        `;
        dialog.showModal();
    } catch (err) {
        showToast("Could not load registration routes: " + err.message, "error");
    }
}

function updateModalStudentYearOptions() {
    const branchEl = document.getElementById("adminStudentBranch");
    const yearEl = document.getElementById("adminStudentYear");
    if (!branchEl || !yearEl) return;
    const branch = branchEl.value;
    yearEl.innerHTML = '<option value="">Select Year</option>';

    let years = [];
    if ([
        "CSE", "CSE (IT)", "CSE (AI)", "CSE (AI & ML)",
        "ECE", "EEE", "Civil", "Mechanical", "Pharmacy"
    ].includes(branch)) {
        years = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
    } else if (branch === "Diploma" || branch === "BBA") {
        years = ["1st Year", "2nd Year", "3rd Year"];
    } else if (branch === "MBA") {
        years = ["1st Year", "2nd Year"];
    }

    years.forEach(item => {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = item;
        yearEl.appendChild(option);
    });
}

async function onModalRouteChange(routeId) {
    const routeSelect = document.getElementById("modalRouteSelect");
    const busIdInput = document.getElementById("modalStudentBusId");
    if (routeSelect && busIdInput) {
        const opt = routeSelect.options[routeSelect.selectedIndex];
        busIdInput.value = opt ? (opt.getAttribute("data-bus-id") || "") : "";
    }

    const stopSelect = document.getElementById("modalStopSelect");
    if (!stopSelect || !routeId) return;
    stopSelect.innerHTML = `<option value="">Loading stops...</option>`;
    try {
        const res = await apiFetch(`/api/routes/${routeId}/stops`);
        const stops = res.stops || [];
        stopSelect.innerHTML = stops.length
            ? `<option value="">Select Pickup Point</option>` + stops.map(s => `<option value="${s.stop_id}">${esc(s.stop_name)} (${esc(s.location || '')})</option>`).join("")
            : `<option value="">No active stops on this route</option>`;
    } catch (err) {
        stopSelect.innerHTML = `<option value="">Failed to load stops</option>`;
    }
}

async function openEditStudentModal(studentId) {
    try {
        const [studentRes, routesRes, busesRes] = await Promise.all([
            apiFetch(`/api/admin/students/${studentId}`),
            apiFetch("/api/routes"),
            apiFetch("/api/buses")
        ]);

        const s = studentRes.student;
        const routes = routesRes.routes || [];
        const buses = busesRes.buses || [];

        // Load stops for student's current route
        let currentStops = [];
        if (s.route_id) {
            const stopsRes = await apiFetch(`/api/routes/${s.route_id}/stops`).catch(() => ({ stops: [] }));
            currentStops = stopsRes.stops || [];
        }

        const dialog = document.getElementById("formDialog");
        document.getElementById("dlgTitle").textContent = `Edit Student: ${s.name}`;
        document.getElementById("dlgBody").innerHTML = `
            <input type="hidden" name="action_type" value="edit_student">
            <input type="hidden" name="student_id" value="${s.student_id}">
            <div class="field">
                <label>Full Name</label>
                <input type="text" name="name" required value="${esc(s.name)}">
            </div>
            <div class="field">
                <label>Roll Number</label>
                <input type="text" name="roll_no" required maxlength="10" value="${esc(s.roll_no)}">
            </div>
            <div class="field">
                <label>Branch</label>
                <input type="text" name="branch" required value="${esc(s.branch)}">
            </div>
            <div class="field">
                <label>Year</label>
                <select name="year" required>
                    ${["1st Year", "2nd Year", "3rd Year", "4th Year"].map(y =>
                        `<option value="${y}" ${s.year === y ? 'selected' : ''}>${y}</option>`
                    ).join("")}
                </select>
            </div>
            <div class="field">
                <label>Phone Number</label>
                <input type="tel" name="phone_no" required pattern="[0-9]{10}" value="${esc(s.phone_no)}">
            </div>
            <div class="field">
                <label>Email Address</label>
                <input type="email" name="email" required value="${esc(s.email)}">
            </div>
            <div class="field full">
                <label>Residential Address</label>
                <input type="text" name="residential_address" required value="${esc(s.residential_address || '')}">
            </div>
            <div class="field">
                <label>New Password (leave blank to keep current)</label>
                <input type="password" name="password" minlength="8" placeholder="Optional new password">
            </div>
            <div class="field">
                <label>Confirm New Password</label>
                <input type="password" name="confirm_password" minlength="8" placeholder="Repeat new password">
            </div>
            <div class="field">
                <label>Assigned Route</label>
                <select name="route_id" id="modalRouteSelect" required onchange="onModalRouteChange(this.value)">
                    <option value="">Select Route</option>
                    ${routes.map(r => `<option value="${r.route_id}" ${s.route_id == r.route_id ? 'selected' : ''}>${esc(r.route_name)}</option>`).join("")}
                </select>
            </div>
            <div class="field">
                <label>Pickup Stop</label>
                <select name="stop_id" id="modalStopSelect" required>
                    ${currentStops.map(st => `<option value="${st.stop_id}" ${s.stop_id == st.stop_id ? 'selected' : ''}>${esc(st.stop_name)}</option>`).join("")}
                </select>
            </div>
            <div class="field full">
                <label>Assigned Bus</label>
                <select name="bus_id" required>
                    <option value="">Select Bus</option>
                    ${buses.map(b => `<option value="${b.bus_id}" ${s.bus_id == b.bus_id ? 'selected' : ''}>${esc(b.bus_number)}</option>`).join("")}
                </select>
            </div>
        `;
        dialog.showModal();
    } catch (err) {
        showToast("Could not load student for editing: " + err.message, "error");
    }
}

async function deactivateStudent(studentId, name) {
    if (!confirm(`Are you sure you want to permanently delete student ${name}? This will remove all their pass and payment records.`)) return;
    try {
        const res = await apiFetch(`/api/admin/students/${studentId}`, { method: "DELETE" });
        showToast(res.message || "Student permanently deleted from database.", "success");
        await Promise.all([loadStudents(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete student: " + err.message, "error");
    }
}

/* =========================================================
   4. DRIVERS MANAGEMENT
========================================================= */

async function loadDrivers() {
    const container = document.getElementById("view-drivers");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading drivers records...</div>`;

    try {
        const res = await apiFetch("/api/admin/drivers");
        state.drivers = res.drivers || [];
        renderDriversView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load drivers: ${esc(err.message)}</div>`;
    }
}

function renderDriversView() {
    const container = document.getElementById("view-drivers");
    if (!container) return;

    const filter = state.filters.driversStatus;
    const query = state.searchQuery.toLowerCase();

    const rows = state.drivers.filter(d => {
        const matchesFilter = filter === "All" || d.status === filter;
        const matchesSearch = !query ||
            d.name.toLowerCase().includes(query) ||
            d.phone.toLowerCase().includes(query) ||
            d.licence.toLowerCase().includes(query) ||
            d.bus.toLowerCase().includes(query);
        return matchesFilter && matchesSearch;
    });

    const totalDrivers = state.drivers.length;
    const activeDrivers = state.drivers.filter(d => d.status === "Active").length;
    const totalPayroll = state.drivers
        .filter(d => d.status === "Active")
        .reduce((sum, d) => sum + Number(d.salary || 0), 0);

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Drivers Management</h1>
                <p class="subtitle">Approved college bus drivers, vehicle assignments and salary payroll.</p>
            </div>
            <button class="btn btn-primary" onclick="openAddDriverModal()">+ Add New Driver</button>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${totalDrivers}</strong><span>Total Drivers</span></div>
            <div class="summary-item"><strong>${activeDrivers}</strong><span>Active Drivers</span></div>
            <div class="summary-item"><strong>${money(totalPayroll)}</strong><span>Monthly Payroll</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Active", "Inactive"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('driversStatus', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} drivers shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Driver</th>
                            <th>Licence Number</th>
                            <th>Assigned Bus</th>
                            <th>Monthly Salary</th>
                            <th>Experience</th>
                            <th>Trip Status</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(d => `
                            <tr>
                                <td>
                                    <strong>${esc(d.name)}</strong>
                                    <small>${esc(d.phone)}</small>
                                </td>
                                <td><code>${esc(d.licence)}</code></td>
                                <td>
                                    <strong>${esc(d.bus)}</strong>
                                    ${d.route ? `<small>${esc(d.route)}</small>` : ''}
                                </td>
                                <td><strong>${money(d.salary)}</strong></td>
                                <td>${(d.experience !== null && d.experience !== undefined && d.experience !== "") ? `${d.experience} years` : "Not provided"}</td>
                                <td>${getBadge(d.trip_status)}</td>
                                <td>${getBadge(d.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewDriverDetails(${d.id})">👁️</button>
                                        <button class="btn-icon btn-icon-edit" title="Edit Driver" onclick="openEditDriverModal(${d.id})">✏️</button>
                                        <button class="btn-icon btn-icon-assign" title="Assign Bus" onclick="openAssignBusToDriverModal(${d.id}, '${esc(d.name)}')">🚌</button>
                                        <button class="btn-icon btn-icon-delete" title="Delete / Deactivate Driver" onclick="deleteDriver(${d.id}, '${esc(d.name)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="8">No drivers found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function viewDriverDetails(driverId) {
    const d = state.drivers.find(x => x.id === driverId);
    if (!d) return;
    openDetailsModal(`Driver Details: ${d.name}`, [
        { label: "Driver ID", value: `#DRV-${d.id}` },
        { label: "Full Name", value: d.name },
        { label: "Phone Number", value: d.phone },
        { label: "Email Address", value: d.email },
        { label: "Driving Licence", value: d.licence },
        { label: "Assigned Bus", value: d.bus_number ? `${d.bus_number} (${d.bus_name || 'Campus Bus'})` : "None" },
        { label: "Assigned Route", value: d.route || "None" },
        { label: "Monthly Salary", value: money(d.salary) },
        { label: "Driving Experience", value: (d.experience !== null && d.experience !== undefined && d.experience !== "") ? `${d.experience} Years` : "Not provided" },
        { label: "Current Trip Status", value: getBadge(d.trip_status) },
        { label: "Account Status", value: getBadge(d.status) }
    ]);
}

function openAddDriverModal() {
    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = "Add New Driver";
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="add_driver">
        <div class="field full">
            <label for="adminDriverName">Driver Name <span style="color:#e11d48;">*</span></label>
            <input type="text" id="adminDriverName" name="name" required placeholder="Enter driver name">
        </div>
        <div class="field">
            <label for="adminDriverPhone">Phone Number <span style="color:#e11d48;">*</span></label>
            <input type="tel" id="adminDriverPhone" name="phone_no" required placeholder="Enter 10-digit phone number" maxlength="10" pattern="[0-9]{10}">
        </div>
        <div class="field">
            <label for="adminDriverEmail">Email <span style="color:#e11d48;">*</span></label>
            <input type="email" id="adminDriverEmail" name="email" required placeholder="Enter driver email">
        </div>
        <div class="field">
            <label for="adminDriverLicense">Driving Licence Number <span style="color:#e11d48;">*</span></label>
            <input type="text" id="adminDriverLicense" name="license_no" required placeholder="Enter driving licence number" maxlength="20" pattern="[A-Za-z0-9 /-]{1,20}" autocomplete="off">
            <small style="color:var(--text-muted); font-size:11px; margin-top:3px;">Maximum 20 characters. Letters, numbers, spaces, / and - are allowed.</small>
        </div>
        <div class="field">
            <label for="adminDriverExperience">Driving Experience (Years) <span style="color:#e11d48;">*</span></label>
            <input type="number" id="adminDriverExperience" name="experience" required placeholder="Enter driving experience (e.g. 5)" min="0" max="60" step="1">
            <small style="color:var(--text-muted); font-size:11px; margin-top:3px;">Enter total years of commercial or heavy vehicle driving experience.</small>
        </div>
        <div class="field full">
            <label for="adminDriverLicensePhoto">Driving licence photo <span style="color:#e11d48;">*</span></label>
            <input type="file" id="adminDriverLicensePhoto" name="license_photo" required accept=".jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.pdf,image/*,application/pdf">
            <small style="color:var(--text-muted); font-size:11px; margin-top:3px;">Upload driving licence copy (JPG, PNG, WEBP, GIF, BMP, HEIC, or PDF. Max 5 MB).</small>
        </div>
        <div class="field">
            <label for="adminDriverPassword">Password <span style="color:#e11d48;">*</span></label>
            <input type="password" id="adminDriverPassword" name="password" required minlength="8" placeholder="Create a password">
        </div>
        <div class="field">
            <label for="adminDriverConfirmPassword">Confirm Password <span style="color:#e11d48;">*</span></label>
            <input type="password" id="adminDriverConfirmPassword" name="confirm_password" required minlength="8" placeholder="Confirm your password">
        </div>
    `;
    dialog.showModal();
}

function openEditDriverModal(driverId) {
    const d = state.drivers.find(x => x.id === driverId);
    if (!d) return;

    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = `Edit Driver: ${d.name}`;
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="edit_driver">
        <input type="hidden" name="driver_id" value="${d.id}">
        <div class="field">
            <label>Driver Name</label>
            <input type="text" name="name" required value="${esc(d.name)}">
        </div>
        <div class="field">
            <label>Phone Number</label>
            <input type="tel" name="phone" required pattern="[0-9]{10}" value="${esc(d.phone)}">
        </div>
        <div class="field">
            <label>Email Address</label>
            <input type="email" name="email" required value="${esc(d.email)}">
        </div>
        <div class="field">
            <label>Licence Number</label>
            <input type="text" name="licence" required value="${esc(d.licence)}">
        </div>
        <div class="field">
            <label>Monthly Salary (₹)</label>
            <input type="number" name="salary" required min="0" step="500" value="${d.salary}">
        </div>
        <div class="field">
            <label>Experience (Years)</label>
            <input type="number" name="experience" required min="0" max="60" value="${d.experience}">
        </div>
        <div class="field full">
            <label>Driver Status</label>
            <select name="status" required>
                <option value="Active" ${d.status === 'Active' ? 'selected' : ''}>Active</option>
                <option value="Inactive" ${d.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
            </select>
        </div>
    `;
    dialog.showModal();
}

async function openAssignBusToDriverModal(driverId, driverName) {
    try {
        const res = await apiFetch("/api/admin/buses");
        const buses = res.buses || [];

        const dialog = document.getElementById("formDialog");
        document.getElementById("dlgTitle").textContent = `Assign Bus to ${driverName}`;
        document.getElementById("dlgBody").innerHTML = `
            <input type="hidden" name="action_type" value="assign_bus_to_driver">
            <input type="hidden" name="driver_id" value="${driverId}">
            <div class="field full">
                <label>Select Bus</label>
                <select name="bus_id" required>
                    <option value="0">Unassign Current Bus</option>
                    ${buses.map(b => `<option value="${b.bus_id}">${esc(b.bus_number)} (${esc(b.bus_name || 'Campus Bus')}) — ${b.condition}</option>`).join("")}
                </select>
            </div>
            <div class="field full">
                <p style="font-size: 11px; color: #526079; line-height: 1.5;">
                    Assigning a bus updates the college bus assignments in MySQL and guarantees no driver conflict occurs.
                </p>
            </div>
        `;
        dialog.showModal();
    } catch (err) {
        showToast("Could not load buses list: " + err.message, "error");
    }
}

async function deleteDriver(driverId, name) {
    if (!confirm(`Are you sure you want to permanently delete driver ${name}? This will unassign any active buses.`)) return;
    try {
        const res = await apiFetch(`/api/admin/drivers/${driverId}`, { method: "DELETE" });
        showToast(res.message || "Driver permanently deleted from database.", "success");
        await Promise.all([loadDrivers(), loadBuses(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete driver: " + err.message, "error");
    }
}

/* =========================================================
   5. BUSES MANAGEMENT
========================================================= */

async function loadBuses() {
    const container = document.getElementById("view-buses");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading buses from database...</div>`;

    try {
        const res = await apiFetch("/api/admin/buses");
        state.buses = res.buses || [];
        renderBusesView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load buses: ${esc(err.message)}</div>`;
    }
}

function renderBusesView() {
    const container = document.getElementById("view-buses");
    if (!container) return;

    const filter = state.filters.busesCondition;
    const query = state.searchQuery.toLowerCase();

    const rows = state.buses.filter(b => {
        const matchesFilter = filter === "All" || b.condition === filter || b.status === filter;
        const matchesSearch = !query ||
            b.number.toLowerCase().includes(query) ||
            b.name.toLowerCase().includes(query) ||
            b.driver.toLowerCase().includes(query) ||
            b.route.toLowerCase().includes(query);
        return matchesFilter && matchesSearch;
    });

    const totalBuses = state.buses.length;
    const workingCount = state.buses.filter(b => b.condition === "Working").length;
    const notWorkingCount = state.buses.filter(b => b.condition === "Not working").length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Buses Management</h1>
                <p class="subtitle">College fleet condition, seating capacity and driver assignments.</p>
            </div>
            <button class="btn btn-primary" onclick="openAddBusModal()">+ Add New Bus</button>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${totalBuses}</strong><span>Total Fleet</span></div>
            <div class="summary-item"><strong>${workingCount}</strong><span>Working Buses</span></div>
            <div class="summary-item"><strong>${notWorkingCount}</strong><span>Not Working / Maintenance</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Working", "Not working", "Active", "Available", "Maintenance"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('busesCondition', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} buses shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Bus Number / Plate</th>
                            <th>Bus Name</th>
                            <th>Seating Capacity</th>
                            <th>Assigned Driver</th>
                            <th>Current Trip</th>
                            <th>Condition</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(b => `
                            <tr>
                                <td><strong>${esc(b.number)}</strong></td>
                                <td>${esc(b.name || 'Campus Bus')}</td>
                                <td>${b.capacity} seats</td>
                                <td>
                                    <strong>${esc(b.driver)}</strong>
                                    ${b.driver_phone ? `<small>${esc(b.driver_phone)}</small>` : ''}
                                </td>
                                <td>${getBadge(b.trip_status)}</td>
                                <td>${getBadge(b.condition)}</td>
                                <td>${getBadge(b.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-edit" title="Edit Bus" onclick="openEditBusModal(${b.id})">✏️</button>
                                        <button class="btn-icon btn-icon-assign" title="Assign Driver" onclick="openAssignDriverToBusModal(${b.id}, '${esc(b.number)}')">👤</button>
                                        <button class="btn-icon ${b.condition === 'Working' ? 'btn-icon-delete' : 'btn-icon-success'}" title="${b.condition === 'Working' ? 'Mark Inactive' : 'Mark Active'}" onclick="toggleBusStatus(${b.id}, '${b.status}')">
                                            ${b.condition === 'Working' ? '⏸️' : '▶️'}
                                        </button>
                                        <button class="btn-icon btn-icon-delete" title="Delete Bus" onclick="deleteBus(${b.id}, '${esc(b.number)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="8">No buses found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function openAddBusModal() {
    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = "Add New College Bus";
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="add_bus">
        <div class="field">
            <label>Bus Number / Reg. Plate</label>
            <input type="text" name="bus_number" required placeholder="e.g. BUS-07 or AP04-CC-1234">
        </div>
        <div class="field">
            <label>Bus Name / Tag</label>
            <input type="text" name="bus_name" placeholder="e.g. CAMPUS BUS 7 (TIRUPATI EXPRESS)">
        </div>
        <div class="field">
            <label>Seating Capacity</label>
            <input type="number" name="capacity" required min="10" max="100" value="50">
        </div>
        <div class="field">
            <label>Status</label>
            <select name="status" required>
                <option value="Active">Active</option>
                <option value="Available">Available</option>
                <option value="Not Working">Not Working</option>
                <option value="Maintenance">Maintenance</option>
            </select>
        </div>
    `;
    dialog.showModal();
}

function openEditBusModal(busId) {
    const b = state.buses.find(x => x.id === busId);
    if (!b) return;

    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = `Edit Bus: ${b.number}`;
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="edit_bus">
        <input type="hidden" name="bus_id" value="${b.id}">
        <div class="field">
            <label>Bus Registration Number</label>
            <input type="text" name="bus_number" required value="${esc(b.number)}">
        </div>
        <div class="field">
            <label>Bus Name / Tag</label>
            <input type="text" name="bus_name" value="${esc(b.name || '')}">
        </div>
        <div class="field">
            <label>Seating Capacity</label>
            <input type="number" name="capacity" required min="10" max="100" value="${b.capacity}">
        </div>
        <div class="field">
            <label>Fleet Status</label>
            <select name="status" required>
                <option value="Active" ${b.status === 'Active' ? 'selected' : ''}>Active</option>
                <option value="Available" ${b.status === 'Available' ? 'selected' : ''}>Available</option>
                <option value="Not Working" ${b.status === 'Not Working' ? 'selected' : ''}>Not Working</option>
                <option value="Maintenance" ${b.status === 'Maintenance' ? 'selected' : ''}>Maintenance</option>
            </select>
        </div>
    `;
    dialog.showModal();
}

async function openAssignDriverToBusModal(busId, busNumber) {
    try {
        const res = await apiFetch("/api/admin/drivers");
        const drivers = res.drivers || [];

        const dialog = document.getElementById("formDialog");
        document.getElementById("dlgTitle").textContent = `Assign Driver to ${busNumber}`;
        document.getElementById("dlgBody").innerHTML = `
            <input type="hidden" name="action_type" value="assign_driver_to_bus">
            <input type="hidden" name="bus_id" value="${busId}">
            <div class="field full">
                <label>Select Driver</label>
                <select name="driver_id" required>
                    <option value="0">Unassign Driver</option>
                    ${drivers.map(d => `<option value="${d.driver_id}">${esc(d.name)} (${esc(d.phone)}) — ${d.status}</option>`).join("")}
                </select>
            </div>
        `;
        dialog.showModal();
    } catch (err) {
        showToast("Could not load drivers: " + err.message, "error");
    }
}

async function toggleBusStatus(busId, currentStatus) {
    const newStatus = ["Active", "Available"].includes(currentStatus) ? "Not Working" : "Active";
    try {
        await apiFetch(`/api/admin/buses/${busId}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: newStatus })
        });
        showToast(`Bus marked as ${newStatus}.`, "success");
        await Promise.all([loadBuses(), loadStats()]);
    } catch (err) {
        showToast("Status change failed: " + err.message, "error");
    }
}

async function deleteBus(busId, busNumber) {
    if (!confirm(`Are you sure you want to permanently delete bus ${busNumber}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/buses/${busId}`, { method: "DELETE" });
        showToast(res.message || "Bus permanently deleted from database.", "success");
        await Promise.all([loadBuses(), loadDrivers(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete bus: " + err.message, "error");
    }
}

/* =========================================================
   6. ROUTES AND STOPS MANAGEMENT
========================================================= */

async function loadRoutes() {
    const container = document.getElementById("view-routes");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading routes and stops...</div>`;

    try {
        const res = await apiFetch("/api/admin/routes");
        state.routes = res.routes || [];
        renderRoutesView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load routes: ${esc(err.message)}</div>`;
    }
}

function renderRoutesView() {
    const container = document.getElementById("view-routes");
    if (!container) return;

    const query = state.searchQuery.toLowerCase();
    const rows = state.routes.filter(r =>
        !query ||
        r.name.toLowerCase().includes(query) ||
        r.start_location.toLowerCase().includes(query) ||
        r.end_location.toLowerCase().includes(query)
    );

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Routes &amp; Stops Management</h1>
                <p class="subtitle">College bus routes, pickup points, stop ordering and distances from college.</p>
            </div>
            <button class="btn btn-primary" onclick="openAddRouteModal()">+ Add New Route</button>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${state.routes.length}</strong><span>Active Routes</span></div>
            <div class="summary-item"><strong>${state.routes.reduce((acc, r) => acc + r.stops_count, 0)}</strong><span>Total Stops</span></div>
            <div class="summary-item"><strong>${state.routes.reduce((acc, r) => acc + r.students_count, 0)}</strong><span>Students Enrolled</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <span class="subtitle">Click any route row to view its ordered stops sequence</span>
                <span class="subtitle">${rows.length} routes</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Route Name</th>
                            <th>Starting Point</th>
                            <th>Destination</th>
                            <th>Stops Count</th>
                            <th>Students Count</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(r => `
                            <tr class="clickable-row ${state.selectedRouteId === r.id ? 'active-row' : ''}" onclick="selectRoute(${r.id})">
                                <td><strong>${esc(r.name)}</strong></td>
                                <td>${esc(r.start_location)}</td>
                                <td>${esc(r.end_location)}</td>
                                <td><strong>${r.stops_count}</strong> stops</td>
                                <td>${r.students_count} students</td>
                                <td>${getBadge(r.status)}</td>
                                <td>
                                    <div class="actions" onclick="event.stopPropagation()">
                                        <button class="btn-icon btn-icon-view" title="View Stops Sequence" onclick="selectRoute(${r.id})">👁️</button>
                                        <button class="btn-icon btn-icon-edit" title="Edit Route" onclick="openEditRouteModal(${r.id})">✏️</button>
                                        <button class="btn-icon btn-icon-success" title="Add Stop to Route" onclick="openAddStopToRouteModal(${r.id}, '${esc(r.name)}')">➕</button>
                                        <button class="btn-icon btn-icon-delete" title="Delete Route" onclick="deleteRoute(${r.id}, '${esc(r.name)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="7">No routes found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>

        <div id="routeStopsDrawer"></div>
    `;

    if (state.selectedRouteId) {
        renderRouteStopsDrawer();
    }
}

async function selectRoute(routeId) {
    state.selectedRouteId = routeId;
    const drawer = document.getElementById("routeStopsDrawer");
    if (drawer) drawer.innerHTML = `<div class="loading-state">Loading stops sequence...</div>`;

    try {
        const res = await apiFetch(`/api/admin/routes/${routeId}`);
        state.selectedRouteData = res;
        renderRouteStopsDrawer();
        drawer?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
        if (drawer) drawer.innerHTML = `<div class="error-box">Failed to load route stops: ${esc(err.message)}</div>`;
    }
}

function renderRouteStopsDrawer() {
    const drawer = document.getElementById("routeStopsDrawer");
    if (!drawer || !state.selectedRouteData) return;

    const { route, stops } = state.selectedRouteData;

    drawer.innerHTML = `
        <div class="stops-drawer">
            <div class="drawer-header">
                <div>
                    <h2>Route Stops: ${esc(route.route_name)}</h2>
                    <p class="subtitle">Stops arranged in exact travel order from <strong>${esc(route.start_location)}</strong> to <strong>${esc(route.end_location)}</strong></p>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="btn btn-sm btn-primary" onclick="openAddStopToRouteModal(${route.route_id}, '${esc(route.route_name)}')">+ Add Stop to Route</button>
                    <button class="btn btn-sm" onclick="document.getElementById('routeStopsDrawer').innerHTML = ''; state.selectedRouteId = null;">Close</button>
                </div>
            </div>

            <div class="stops-timeline">
                ${stops.length ? stops.map((s, idx) => `
                    <div class="timeline-stop">
                        <div class="timeline-info">
                            <strong>${idx + 1}. ${esc(s.stop_name)}</strong>
                            <span>${esc(s.location || 'Location designated')}</span>
                        </div>
                        <div class="timeline-badges">
                            <span class="badge muted">Distance: <strong>${s.distance_km} km</strong></span>
                            <span class="badge ok">Applicable Fee: <strong>${money(s.applicable_fee)}</strong></span>
                            <span class="badge warn">Students: <strong>${s.student_count}</strong></span>
                            <button class="btn-icon btn-icon-edit" title="Edit Stop Distance & Fee" onclick="openEditStopModal(${s.stop_id}, '${esc(s.stop_name)}', '${esc(s.location)}', ${s.distance_km}, ${s.applicable_fee})">✏️</button>
                            <button class="btn-icon btn-icon-delete" title="Remove Stop from Route" onclick="removeStopFromRoute(${route.route_id}, ${s.stop_id}, '${esc(s.stop_name)}')">🗑️</button>
                        </div>
                    </div>
                `).join("") : `<div class="empty-state">No stops have been assigned to this route yet.</div>`}
            </div>
        </div>
    `;
}

function openAddRouteModal() {
    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = "Create New Transport Route";
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="add_route">
        <div class="field full">
            <label>Route Name / Number</label>
            <input type="text" name="route_name" required placeholder="e.g. Route 105 - Tirupati South">
        </div>
        <div class="field">
            <label>Starting Point</label>
            <input type="text" name="start_location" required placeholder="e.g. Ramanuja Circle">
        </div>
        <div class="field">
            <label>Destination</label>
            <input type="text" name="end_location" required value="Campus Main Gate">
        </div>
        <div class="field full">
            <label>Status</label>
            <select name="status" required>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
            </select>
        </div>
    `;
    dialog.showModal();
}

async function openEditRouteModal(routeId) {
    try {
        const [routeData, stopsRes] = await Promise.all([
            apiFetch(`/api/admin/routes/${routeId}`).catch(() => ({ route: null, stops: [] })),
            apiFetch("/api/admin/all-stops").catch(() => ({ stops: [] }))
        ]);

        const route = routeData.route || state.routes.find(x => x.id === routeId);
        if (!route) {
            showToast("Route not found.", "error");
            return;
        }

        const currentStops = routeData.stops || [];
        const allStops = stopsRes.stops || [];

        const dialog = document.getElementById("formDialog");
        document.getElementById("dlgTitle").textContent = `Edit Route: ${route.route_name || route.name}`;
        document.getElementById("dlgBody").innerHTML = `
            <input type="hidden" name="action_type" value="edit_route">
            <input type="hidden" name="route_id" value="${route.route_id || route.id}">
            
            <div class="field full">
                <label>Route Name / Number</label>
                <input type="text" name="route_name" required value="${esc(route.route_name || route.name)}">
            </div>
            <div class="field">
                <label>Starting Point</label>
                <input type="text" name="start_location" required value="${esc(route.start_location)}">
            </div>
            <div class="field">
                <label>Destination</label>
                <input type="text" name="end_location" required value="${esc(route.end_location)}">
            </div>
            <div class="field full">
                <label>Route Status</label>
                <select name="status" required>
                    <option value="Active" ${route.status === 'Active' ? 'selected' : ''}>Active</option>
                    <option value="Inactive" ${route.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
                </select>
            </div>

            <!-- Stops Sequence Management in Edit Route Dialog -->
            <div class="field full" style="border-top: 1px solid var(--border); padding-top: 14px; margin-top: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="margin: 0; font-weight: 700; color: #172033; font-size: 13px;">Route Stops Sequence (${currentStops.length} stops)</label>
                    <span style="font-size: 11px; color: #64748b;">Arranged in travel order</span>
                </div>

                <div class="modal-stops-list" style="max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 6px; background: #fafbff; margin-bottom: 12px;">
                    ${currentStops.length ? currentStops.map((s, idx) => `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-bottom: 1px solid #edf2fa; background: #ffffff; border-radius: 6px; margin-bottom: 4px;">
                            <div>
                                <strong style="font-size: 12px; color: #172033;">${idx + 1}. ${esc(s.stop_name)}</strong>
                                <span style="font-size: 11px; color: #64748b; margin-left: 8px;">${s.distance_km} km | ₹${Number(s.applicable_fee || 0).toLocaleString('en-IN')}</span>
                            </div>
                            <div style="display: flex; gap: 4px;">
                                <button type="button" class="btn-icon btn-icon-edit" title="Edit Stop" onclick="openEditStopModal(${s.stop_id}, '${esc(s.stop_name)}', '${esc(s.location || '')}', ${s.distance_km}, ${s.applicable_fee})">✏️</button>
                                <button type="button" class="btn-icon btn-icon-delete" title="Remove Stop" onclick="removeStopFromRoute(${route.route_id || route.id}, ${s.stop_id}, '${esc(s.stop_name)}')">🗑️</button>
                            </div>
                        </div>
                    `).join("") : `<div style="padding: 12px; text-align: center; color: #64748b; font-size: 12px;">No stops added yet. Type a stop name below to add one!</div>`}
                </div>

                <!-- Add Stop Form inside Route Edit -->
                <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px; padding: 12px;">
                    <strong style="display: block; font-size: 11px; text-transform: uppercase; color: #334155; margin-bottom: 8px; letter-spacing: 0.5px;">➕ Add Stop to this Route</strong>
                    
                    <datalist id="routeEditStopsDatalist">
                        ${allStops.map(st => `<option value="${esc(st.stop_name)}">${st.distance_km} km (₹${Number(st.fee_amount || 0).toLocaleString('en-IN')})</option>`).join("")}
                    </datalist>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <input type="text" id="inlineNewStopName" list="routeEditStopsDatalist" placeholder="Stop Name (type or pick from list)" onchange="checkInlineAutofill(this.value)" style="grid-column: 1 / -1; padding: 8px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                        <input type="text" id="inlineNewStopLoc" placeholder="Landmark / Location" style="padding: 8px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                        <input type="number" id="inlineNewStopDist" placeholder="Distance (km)" step="0.1" min="0" oninput="onInlineStopDistChange(this.value)" style="padding: 8px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                        <input type="number" id="inlineNewStopFee" placeholder="Fee (₹) [auto-calculated]" step="500" min="0" style="padding: 8px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px;">
                        <button type="button" class="btn btn-sm btn-primary" onclick="quickAddStopToRoute(${route.route_id || route.id})" style="padding: 8px 12px; font-size: 12px; justify-content: center;">+ Add This Stop</button>
                    </div>
                </div>
            </div>
        `;
        window._registeredStopsCache = allStops;
        dialog.showModal();
    } catch (err) {
        showToast("Error opening edit route: " + err.message, "error");
    }
}

function checkInlineAutofill(val) {
    if (!window._registeredStopsCache || !val) return;
    const match = window._registeredStopsCache.find(s => s.stop_name.toLowerCase() === val.trim().toLowerCase());
    if (match) {
        const loc = document.getElementById("inlineNewStopLoc");
        const dist = document.getElementById("inlineNewStopDist");
        const fee = document.getElementById("inlineNewStopFee");
        if (loc && match.location) loc.value = match.location;
        if (dist && match.distance_km) dist.value = match.distance_km;
        if (fee && match.fee_amount) fee.value = match.fee_amount;
    }
}

function onInlineStopDistChange(val) {
    const km = Number(val) || 0;
    const feeEl = document.getElementById("inlineNewStopFee");
    if (!feeEl) return;
    let fee = 8000;
    if (km <= 5) fee = 8000;
    else if (km <= 10) fee = 11000;
    else if (km <= 15) fee = 14000;
    else if (km <= 20) fee = 16000;
    else if (km <= 25) fee = 18000;
    else if (km <= 30) fee = 20000;
    else fee = 22000;
    feeEl.value = fee;
}

async function quickAddStopToRoute(routeId) {
    const nameEl = document.getElementById("inlineNewStopName");
    const locEl = document.getElementById("inlineNewStopLoc");
    const distEl = document.getElementById("inlineNewStopDist");
    const feeEl = document.getElementById("inlineNewStopFee");

    const stop_name = nameEl?.value?.trim();
    if (!stop_name) {
        showToast("Please enter a stop name.", "error");
        nameEl?.focus();
        return;
    }

    try {
        const res = await apiFetch(`/api/admin/routes/${routeId}/stops`, {
            method: "POST",
            body: JSON.stringify({
                stop_name,
                location: locEl?.value?.trim() || "",
                distance_km: distEl?.value || 0,
                fee_amount: feeEl?.value || 0
            })
        });

        showToast(res.message || `Stop "${stop_name}" added to route!`, "success");
        await Promise.all([loadRoutes(), openEditRouteModal(routeId)]);
        if (state.selectedRouteId === routeId) {
            await selectRoute(routeId);
        }
    } catch (err) {
        showToast("Failed to add stop: " + err.message, "error");
    }
}

async function openAddStopToRouteModal(routeId, routeName) {
    try {
        const [stopsRes, routeData] = await Promise.all([
            apiFetch("/api/admin/all-stops").catch(() => ({ stops: [] })),
            apiFetch(`/api/admin/routes/${routeId}`).catch(() => ({ stops: [] }))
        ]);

        const allStops = stopsRes.stops || [];
        const nextOrder = (routeData.stops?.length || 0) + 1;

        const dialog = document.getElementById("formDialog");
        document.getElementById("dlgTitle").textContent = `Add Stop to ${routeName}`;
        document.getElementById("dlgBody").innerHTML = `
            <input type="hidden" name="action_type" value="add_stop_to_route">
            <input type="hidden" name="route_id" value="${routeId}">
            
            <datalist id="allRegisteredStopsDatalist">
                ${allStops.map(s => `<option value="${esc(s.stop_name)}">${s.distance_km} km (₹${Number(s.fee_amount || 0).toLocaleString('en-IN')})</option>`).join("")}
            </datalist>

            <div class="field full">
                <label>Stop Name (Type new stop name or select from registered stops)</label>
                <input type="text" name="stop_name" list="allRegisteredStopsDatalist" id="modalNewStopName" required placeholder="e.g. Alipiri Circle, Tirupati South, Chandragiri" onchange="checkAutofillStop(this.value)">
            </div>

            <div class="field">
                <label>Location / Landmark</label>
                <input type="text" name="location" id="modalNewStopLocation" placeholder="e.g. Near Bus Shelter / Cross Roads">
            </div>

            <div class="field">
                <label>Distance from College (km)</label>
                <input type="number" name="distance_km" id="modalNewStopDistance" step="0.1" min="0" placeholder="e.g. 18.5" oninput="onStopDistanceChange(this.value)">
            </div>

            <div class="field">
                <label>Transport Fee (₹) [Auto-calculated from distance]</label>
                <input type="number" name="fee_amount" id="modalNewStopFee" step="500" min="0" placeholder="e.g. 16000">
            </div>

            <div class="field full">
                <label>Stop Sequence Order in Route</label>
                <input type="number" name="stop_order" required min="1" value="${nextOrder}">
            </div>
        `;
        window._registeredStopsCache = allStops;
        dialog.showModal();
    } catch (err) {
        showToast("Error opening add stop modal: " + err.message, "error");
    }
}

function checkAutofillStop(name) {
    if (!window._registeredStopsCache || !name) return;
    const match = window._registeredStopsCache.find(s => s.stop_name.toLowerCase() === name.trim().toLowerCase());
    if (match) {
        const loc = document.getElementById("modalNewStopLocation");
        const dist = document.getElementById("modalNewStopDistance");
        const fee = document.getElementById("modalNewStopFee");
        if (loc && match.location) loc.value = match.location;
        if (dist && match.distance_km) dist.value = match.distance_km;
        if (fee && match.fee_amount) fee.value = match.fee_amount;
    }
}

function onStopDistanceChange(distanceKm) {
    const km = Number(distanceKm) || 0;
    const feeInput = document.getElementById("modalNewStopFee");
    if (!feeInput) return;
    
    // Auto calculate fee according to VEMU IT transport fee slabs
    let fee = 8000;
    if (km <= 5) fee = 8000;
    else if (km <= 10) fee = 11000;
    else if (km <= 15) fee = 14000;
    else if (km <= 20) fee = 16000;
    else if (km <= 25) fee = 18000;
    else if (km <= 30) fee = 20000;
    else fee = 22000;

    feeInput.value = fee;
}

function openEditStopModal(stopId, stopName, location, distanceKm, feeAmount) {
    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = `Edit Stop: ${stopName}`;
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="edit_stop">
        <input type="hidden" name="stop_id" value="${stopId}">
        <div class="field">
            <label>Stop Name</label>
            <input type="text" name="stop_name" required value="${esc(stopName)}">
        </div>
        <div class="field">
            <label>Location Landmark</label>
            <input type="text" name="location" value="${esc(location || '')}">
        </div>
        <div class="field">
            <label>Distance from College (km)</label>
            <input type="number" name="distance_km" id="modalEditStopDist" required step="0.1" min="0" value="${distanceKm}" oninput="onStopDistanceChange(this.value)">
        </div>
        <div class="field">
            <label>Applicable Transport Fee (₹)</label>
            <input type="number" name="fee_amount" id="modalNewStopFee" required min="0" step="100" value="${feeAmount}">
        </div>
        <div class="field full">
            <p style="font-size: 11px; color: #526079; line-height: 1.5;">
                Saving this will update the stop distance and save the verified fee in the MySQL fees table for this stop.
            </p>
        </div>
    `;
    dialog.showModal();
}

async function deleteRoute(routeId, routeName) {
    // Fetch impact counts before confirming
    let students = 0, buses = 0, passRequests = 0;
    try {
        const info = await apiFetch(`/api/admin/routes/${routeId}`);
        if (info && info.route) {
            students    = info.route.students_count || 0;
            buses       = (info.route.assigned_buses && info.route.assigned_buses !== "None") ? info.route.assigned_buses.split(",").length : 0;
            passRequests = 0; // not exposed separately; server decides
        }
    } catch (_) {}

    const impact = [
        students    > 0 ? `${students} student(s)` : null,
        buses       > 0 ? `${buses} bus(es)` : null
    ].filter(Boolean).join(", ");

    const confirmMsg = impact
        ? `Delete route "${routeName}"?\n\nImpact: ${impact} are linked to this route.\nThe route will be archived and removed from all active lists.`
        : `Delete route "${routeName}" and all its stops? This cannot be undone.`;

    if (!confirm(confirmMsg)) return;

    // Disable the delete button while running
    const btn = document.querySelector(`button[onclick="deleteRoute(${routeId}, '${routeName.replace(/'/g, "\\'")}')"]`);
    if (btn) { btn.disabled = true; btn.style.opacity = "0.5"; }

    try {
        const res = await apiFetch(`/api/admin/routes/${routeId}`, { method: "DELETE" });
        const toastType = res.mode === "archived" ? "warning" : "success";
        showToast(res.message || "Route deleted successfully.", toastType);
        if (state.selectedRouteId === routeId) {
            state.selectedRouteId = null;
            const drawer = document.getElementById("routeStopsDrawer");
            if (drawer) drawer.innerHTML = "";
        }
        await Promise.all([loadRoutes(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete route: " + (err.message || "Please try again."), "error");
        if (btn) { btn.disabled = false; btn.style.opacity = ""; }
    }
}

async function removeStopFromRoute(routeId, stopId, stopName) {
    if (!confirm(`Remove stop "${stopName}" from this route?`)) return;
    try {
        const res = await apiFetch(`/api/admin/routes/${routeId}/stops/${stopId}`, { method: "DELETE" });
        showToast(res.message || "Stop removed from route.", "success");
        await selectRoute(routeId);
        await loadRoutes();
    } catch (err) {
        showToast("Failed to remove stop: " + err.message, "error");
    }
}

/* =========================================================
   7. DISTANCE-BASED FEE ASSIGNMENTS
========================================================= */

async function loadFeeAssignments() {
    const container = document.getElementById("view-fee-assignments");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading distance-based fee assignments...</div>`;

    try {
        const res = await apiFetch("/api/admin/fee-assignments");
        state.feeAssignments = res.assignments || [];
        renderFeeAssignmentsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load fee assignments: ${esc(err.message)}</div>`;
    }
}

function renderFeeAssignmentsView() {
    const container = document.getElementById("view-fee-assignments");
    if (!container) return;

    const filter = state.filters.studentsFee;
    const query = state.searchQuery.toLowerCase();

    const rows = state.feeAssignments.filter(item => {
        const matchesFilter = filter === "All" || item.status === filter;
        const matchesSearch = !query ||
            item.student_name.toLowerCase().includes(query) ||
            item.roll_no.toLowerCase().includes(query) ||
            item.route_name.toLowerCase().includes(query) ||
            item.stop_name.toLowerCase().includes(query);
        return matchesFilter && matchesSearch;
    });

    const totalAssignedFee = state.feeAssignments.reduce((acc, i) => acc + i.applicable_fee, 0);
    const totalCollected = state.feeAssignments.reduce((acc, i) => acc + i.total_paid, 0);
    const totalOutstanding = state.feeAssignments.reduce((acc, i) => acc + i.outstanding_amount, 0);

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Distance-Based Fee Assignments</h1>
                <p class="subtitle">Transportation fees calculated from verified distance from VEMU IT campus.</p>
            </div>
        </div>

        <div class="fee-slab-banner">
            <h3>College Transportation Pricing Rules</h3>
            <p>Annual bus fees are calculated directly from verified road distance between the college campus and student pickup stops:</p>
            <div class="slab-chips">
                <span class="slab-chip">0 – 5 km: <strong>₹8,000</strong></span>
                <span class="slab-chip">5.1 – 10 km: <strong>₹11,000</strong></span>
                <span class="slab-chip">10.1 – 15 km: <strong>₹14,000</strong></span>
                <span class="slab-chip">15.1 – 20 km: <strong>₹16,000</strong></span>
                <span class="slab-chip">20.1 – 25 km: <strong>₹18,000</strong></span>
                <span class="slab-chip">25.1 – 30 km: <strong>₹20,000</strong></span>
                <span class="slab-chip">Above 30 km: <strong>₹22,000</strong></span>
            </div>
        </div>

        <div class="summary-strip">
            <div class="summary-item"><strong>${money(totalAssignedFee)}</strong><span>Total Assigned Fees</span></div>
            <div class="summary-item"><strong>${money(totalCollected)}</strong><span>Total Collected</span></div>
            <div class="summary-item"><strong>${money(totalOutstanding)}</strong><span>Total Outstanding</span></div>
        </div>

        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Paid", "Partially Paid", "Unpaid", "Pending Verification"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('studentsFee', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} fee assignments shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>Route &amp; Stop</th>
                            <th>Distance</th>
                            <th>Applicable Fee</th>
                            <th>Amount Paid</th>
                            <th>Outstanding</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(i => `
                            <tr>
                                <td>
                                    <strong>${esc(i.student_name)}</strong>
                                    <small>${esc(i.roll_no)} — ${esc(i.branch)}</small>
                                </td>
                                <td>
                                    <strong>${esc(i.route_name)}</strong>
                                    <small>${esc(i.stop_name)}</small>
                                </td>
                                <td><strong>${i.distance_km} km</strong></td>
                                <td>
                                    <strong>${money(i.applicable_fee)}</strong>
                                    <small>${esc(i.fee_source)}</small>
                                </td>
                                <td><strong style="color: #059669;">${money(i.total_paid)}</strong></td>
                                <td><strong style="color: ${i.outstanding_amount > 0 ? '#dc2626' : '#059669'};">${money(i.outstanding_amount)}</strong></td>
                                <td>${getBadge(i.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-edit" title="Adjust Fee for Stop" onclick="openAdjustStopFeeModal(${i.stop_id}, '${esc(i.stop_name)}', ${i.applicable_fee})">✏️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="8">No fee assignment records found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function openAdjustStopFeeModal(stopId, stopName, currentFee) {
    const dialog = document.getElementById("formDialog");
    document.getElementById("dlgTitle").textContent = `Adjust Fee for Stop: ${stopName}`;
    document.getElementById("dlgBody").innerHTML = `
        <input type="hidden" name="action_type" value="adjust_stop_fee">
        <input type="hidden" name="stop_id" value="${stopId}">
        <div class="field full">
            <label>Annual Fee for this Stop (₹)</label>
            <input type="number" name="amount" required min="0" step="500" value="${currentFee}">
        </div>
        <div class="field full">
            <p style="font-size: 11px; color: #526079; line-height: 1.5;">
                This updates the official fees table for this pickup stop and recalculates student balances automatically.
            </p>
        </div>
    `;
    dialog.showModal();
}

/* =========================================================
   8. PAYMENTS MANAGEMENT
========================================================= */

function getPaymentStatusCategory(status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "success") return "Success";
    if (normalized === "pending" || normalized === "pending verification") return "Pending";
    if (normalized === "failed" || normalized === "failure") return "Failed";
    return String(status || "").trim();
}

async function loadPayments() {
    const container = document.getElementById("view-payments");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading actual payment records from database...</div>`;

    try {
        const res = await apiFetch("/api/admin/payments");
        state.payments = res.payments || [];
        renderPaymentsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load payments: ${esc(err.message)}</div>`;
    }
}

function renderPaymentsView() {
    const container = document.getElementById("view-payments");
    if (!container) return;

    const filter = state.filters.paymentsStatus;
    const query = state.searchQuery.toLowerCase();

    const rows = state.payments.filter(p => {
        const matchesFilter = filter === "All" || getPaymentStatusCategory(p.status) === filter;
        const matchesSearch = !query ||
            p.student_name.toLowerCase().includes(query) ||
            p.roll_no.toLowerCase().includes(query) ||
            p.transaction_id.toLowerCase().includes(query) ||
            p.method.toLowerCase().includes(query);
        return matchesFilter && matchesSearch;
    });

    const totalCollected = state.payments
        .filter(p => getPaymentStatusCategory(p.status) === "Success")
        .reduce((sum, p) => sum + p.amount, 0);

    const pendingVerification = state.payments
        .filter(p => getPaymentStatusCategory(p.status) === "Pending")
        .reduce((sum, p) => sum + p.amount, 0);

    const pendingCount = state.payments.filter(p => getPaymentStatusCategory(p.status) === "Pending").length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Payments Management</h1>
                <p class="subtitle">Real payment transactions recorded in MySQL database.</p>
            </div>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${money(totalCollected)}</strong><span>Total Collected</span></div>
            <div class="summary-item"><strong>${money(pendingVerification)}</strong><span>Pending Verification (${pendingCount})</span></div>
            <div class="summary-item"><strong>${state.payments.length}</strong><span>Total Transactions</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Success", "Pending", "Failed"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('paymentsStatus', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} transactions shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>Pickup Stop</th>
                            <th>Amount Paid</th>
                            <th>Transaction Ref.</th>
                            <th>Payment Method</th>
                            <th>Payment Date</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(p => `
                            <tr>
                                <td>
                                    <strong>${esc(p.student_name)}</strong>
                                    <small>${esc(p.roll_no)}</small>
                                </td>
                                <td>
                                    <strong>${esc(p.stop_name)}</strong>
                                    <small>${esc(p.route_name)}</small>
                                </td>
                                <td><strong>${money(p.amount)}</strong></td>
                                <td><code>${esc(p.transaction_id)}</code></td>
                                <td>${esc(p.method)}</td>
                                <td>${formatDateTime(p.date)}</td>
                                <td>${getBadge(p.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewPaymentDetails(${p.id})">👁️</button>
                                        <button class="btn-icon btn-icon-print" title="Print Official Receipt" onclick="printPaymentReceipt(${p.id})">🖨️</button>
                                        ${getPaymentStatusCategory(p.status) === 'Pending' ? `
                                            <button class="btn-icon btn-icon-success" title="Verify Payment" onclick="verifyPayment(${p.id}, 'Success')">✓</button>
                                            <button class="btn-icon btn-icon-delete" title="Reject Payment" onclick="verifyPayment(${p.id}, 'Failed')">✕</button>
                                        ` : ''}
                                        <button class="btn-icon btn-icon-delete" title="Delete Payment Record" onclick="deletePayment(${p.id})">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="8">No payment records found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function viewPaymentDetails(paymentId) {
    const p = state.payments.find(x => x.id === paymentId);
    if (!p) return;
    state.activePayment = p;
    openDetailsModal(`Payment Transaction: #${p.id}`, [
        { label: "Payment ID", value: `#PAY-${p.id}` },
        { label: "Receipt Number", value: `RCP-PAY-${String(p.id).padStart(6, '0')}` },
        { label: "Student Name", value: p.student_name },
        { label: "Roll Number", value: p.roll_no },
        { label: "Branch", value: p.branch || "N/A" },
        { label: "Contact Phone", value: p.phone || "N/A" },
        { label: "Route & Stop", value: `${p.route_name} — ${p.stop_name} (${p.distance_km} km)` },
        { label: "Applicable Stop Fee", value: money(p.applicable_fee) },
        { label: "Transaction Amount", value: money(p.amount) },
        { label: "Transaction Reference", value: p.transaction_id },
        { label: "UPI ID / VPA", value: p.upi_id || "N/A" },
        { label: "Payment Method", value: p.method },
        { label: "Payment Status", value: getBadge(p.status) },
        { label: "Payment Date", value: formatDateTime(p.date) }
    ], `
        <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn-secondary" onclick="openReceiptModal(${p.id})">👁️ Preview Receipt</button>
            <button type="button" class="btn btn-primary" onclick="printPaymentReceipt(${p.id})">🖨️ Print Official Receipt</button>
        </div>
    `);
}

async function verifyPayment(paymentId, newStatus) {
    const actionText = newStatus === "Success" ? "verify and approve" : "reject";
    if (!confirm(`Are you sure you want to ${actionText} payment #${paymentId}?`)) return;

    try {
        const res = await apiFetch(`/api/admin/payments/${paymentId}/verify`, {
            method: "PATCH",
            body: JSON.stringify({ status: newStatus })
        });
        showToast(res.message || `Payment marked as ${newStatus}.`, "success");
        await Promise.all([loadPayments(), loadStats()]);
    } catch (err) {
        showToast("Payment verification failed: " + err.message, "error");
    }
}

async function deletePayment(paymentId) {
    if (!confirm(`Are you sure you want to delete payment transaction #${paymentId}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/payments/${paymentId}`, { method: "DELETE" });
        showToast(res.message || "Payment transaction deleted.", "success");
        await Promise.all([loadPayments(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete payment: " + err.message, "error");
    }
}

/* =========================================================
   9. BUS PASS REQUESTS
========================================================= */

async function loadPassRequests() {
    const container = document.getElementById("view-pass-requests");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading bus pass requests from database...</div>`;

    try {
        const res = await apiFetch("/api/admin/bus-pass-requests");
        state.passRequests = res.requests || [];
        renderPassRequestsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load bus pass requests: ${esc(err.message)}</div>`;
    }
}

function renderPassRequestsView() {
    const container = document.getElementById("view-pass-requests");
    if (!container) return;

    const filter = state.filters.passRequestsStatus;
    const query = state.searchQuery.toLowerCase();

    const rows = state.passRequests.filter(r => {
        const matchesFilter = filter === "All" || r.status === filter;
        const matchesSearch = !query ||
            r.student_name.toLowerCase().includes(query) ||
            r.roll_no.toLowerCase().includes(query) ||
            r.route.toLowerCase().includes(query) ||
            r.stop.toLowerCase().includes(query);
        return matchesFilter && matchesSearch;
    });

    const pendingCount = state.passRequests.filter(r => r.status === "Pending").length;
    const approvedCount = state.passRequests.filter(r => r.status === "Approved").length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Bus Pass Requests</h1>
                <p class="subtitle">Review student transportation pass requests and issue verifiable bus passes.</p>
            </div>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${pendingCount}</strong><span>Pending Approval</span></div>
            <div class="summary-item"><strong>${approvedCount}</strong><span>Approved Requests</span></div>
            <div class="summary-item"><strong>${state.passRequests.length}</strong><span>Total Requests</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Pending", "Approved", "Rejected"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('passRequestsStatus', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} requests shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>Route &amp; Stop</th>
                            <th>Assigned Bus</th>
                            <th>Fee Payment Status</th>
                            <th>Requested Date</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(r => `
                            <tr>
                                <td>
                                    <strong>${esc(r.student_name)}</strong>
                                    <small>${esc(r.roll_no)} — ${esc(r.branch)}</small>
                                    ${r.passport_photo ? `
                                        <div style="margin-top: 4px;">
                                            <a href="${API_BASE}${r.passport_photo.startsWith('/') ? '' : '/'}${r.passport_photo}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: #2563eb; font-weight: 700; text-decoration: none;">
                                                📷 View Photo
                                            </a>
                                        </div>
                                    ` : ''}
                                </td>
                                <td>
                                    <strong>${esc(r.route)}</strong>
                                    <small>${esc(r.stop)}</small>
                                </td>
                                <td><strong>${esc(r.bus)}</strong></td>
                                <td>
                                    ${getBadge(r.payment_status)}
                                    <small style="display:block;">${money(r.payment_amount)}</small>
                                </td>
                                <td>${formatDateTime(r.date)}</td>
                                <td>${getBadge(r.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewPassRequestDetails(${r.id})">👁️</button>
                                        ${r.status === 'Pending' ? `
                                            <button class="btn-icon btn-icon-success" title="Approve & Issue Pass" onclick="approvePassRequest(${r.id}, '${esc(r.student_name)}')">✓</button>
                                            <button class="btn-icon btn-icon-delete" title="Reject Request" onclick="rejectPassRequest(${r.id}, '${esc(r.student_name)}')">✕</button>
                                        ` : ''}
                                        <button class="btn-icon btn-icon-delete" title="Delete Pass Request" onclick="deletePassRequest(${r.id}, '${esc(r.student_name)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="7">No bus pass requests found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function viewPassRequestDetails(id) {
    const r = state.passRequests.find(x => x.id === id);
    if (!r) return;
    openDetailsModal(`Bus Pass Request: #${r.id}`, [
        { label: "Request ID", value: `#PASS-REQ-${r.id}` },
        { label: "Student Name", value: r.student_name },
        { label: "Roll Number", value: r.roll_no },
        { label: "Branch", value: r.branch },
        { label: "Passport Photo", value: r.passport_photo ? `<a href="${API_BASE}${r.passport_photo.startsWith('/') ? '' : '/'}${r.passport_photo}" target="_blank" rel="noopener noreferrer" style="color: #2563EB; font-weight: 700; text-decoration: underline; display: inline-flex; align-items: center; gap: 4px;">📷 View Uploaded Photo</a>` : `<span style="color: #94a3b8;">Not uploaded</span>` },
        { label: "Phone Number", value: r.phone },
        { label: "Selected Route", value: r.route },
        { label: "Pickup Stop", value: r.stop },
        { label: "Assigned Bus", value: r.bus },
        { label: "Fee Payment Status", value: getBadge(r.payment_status) },
        { label: "Payment Amount", value: money(r.payment_amount) },
        { label: "Requested At", value: formatDateTime(r.date) },
        { label: "Approval Status", value: getBadge(r.status) },
        { label: "Generated Pass", value: r.pass_number || "Not yet generated" }
    ]);
}

async function approvePassRequest(requestId, studentName) {
    if (!confirm(`Approve transportation request for ${studentName} and generate official Bus Pass in MySQL?`)) return;

    try {
        const res = await apiFetch(`/api/admin/bus-pass-requests/${requestId}/approve`, {
            method: "POST",
            body: JSON.stringify({ admin_id: 1 })
        });

        showToast(res.message || "Bus pass issued successfully!", "success");
        await Promise.all([loadPassRequests(), loadBusPasses(), loadStats()]);

        if (res.pass_id) {
            openPassCardModal(res.pass_id);
        }
    } catch (err) {
        showToast("Pass approval error: " + err.message, "error");
    }
}

async function rejectPassRequest(requestId, studentName) {
    const remarks = prompt(`Enter rejection remarks for ${studentName}'s pass request:`, "Fee payment verification pending.");
    if (remarks === null) return;

    try {
        const res = await apiFetch(`/api/admin/bus-pass-requests/${requestId}/reject`, {
            method: "POST",
            body: JSON.stringify({ remarks })
        });
        showToast(res.message || "Request rejected.", "info");
        await Promise.all([loadPassRequests(), loadStats()]);
    } catch (err) {
        showToast("Rejection failed: " + err.message, "error");
    }
}

async function deletePassRequest(requestId, studentName) {
    if (!confirm(`Are you sure you want to delete pass request #${requestId} for ${studentName}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/bus-pass-requests/${requestId}`, { method: "DELETE" });
        showToast(res.message || "Bus pass request deleted.", "success");
        await Promise.all([loadPassRequests(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete pass request: " + err.message, "error");
    }
}

/* =========================================================
   10. GENERATED BUS PASSES
========================================================= */

async function loadBusPasses() {
    const container = document.getElementById("view-bus-passes");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading generated bus passes...</div>`;

    try {
        const res = await apiFetch("/api/admin/bus-passes");
        state.busPasses = res.passes || [];
        renderBusPassesView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load passes: ${esc(err.message)}</div>`;
    }
}

function renderBusPassesView() {
    const container = document.getElementById("view-bus-passes");
    if (!container) return;

    const query = state.searchQuery.toLowerCase();
    const rows = state.busPasses.filter(p =>
        !query ||
        p.pass_number.toLowerCase().includes(query) ||
        p.student_name.toLowerCase().includes(query) ||
        p.roll_no.toLowerCase().includes(query) ||
        p.route_name.toLowerCase().includes(query) ||
        p.stop_name.toLowerCase().includes(query)
    );

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Generated Bus Passes</h1>
                <p class="subtitle">Official student college transportation passes verified in MySQL.</p>
            </div>
        </div>
        <div class="summary-strip">
            <div class="summary-item"><strong>${state.busPasses.length}</strong><span>Active Issued Passes</span></div>
            <div class="summary-item"><strong>2026–2027</strong><span>Academic Validity</span></div>
            <div class="summary-item"><strong>VEMU IT</strong><span>Institution</span></div>
        </div>
        <div class="table-card">
            <div class="table-toolbar">
                <span class="subtitle">Search by pass number, student name or roll number</span>
                <span class="subtitle">${rows.length} passes shown</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Pass Number</th>
                            <th>Student</th>
                            <th>Route &amp; Stop</th>
                            <th>Bus Number</th>
                            <th>Validity Period</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(p => `
                            <tr>
                                <td><code style="font-size:12px; font-weight:700;">${esc(p.pass_number)}</code></td>
                                <td>
                                    <strong>${esc(p.student_name)}</strong>
                                    <small>${esc(p.roll_no)} — ${esc(p.branch)}</small>
                                </td>
                                <td>
                                    <strong>${esc(p.route_name)}</strong>
                                    <small>${esc(p.stop_name)}</small>
                                </td>
                                <td>
                                    <strong>${esc(p.bus_number)}</strong>
                                    <small>${esc(p.driver_name || 'Driver assigned')}</small>
                                </td>
                                <td>
                                    <strong>${formatDate(p.valid_from)}</strong> to
                                    <strong>${formatDate(p.valid_to)}</strong>
                                </td>
                                <td>${getBadge(p.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Pass" onclick="openPassCardModal(${p.id})">👁️</button>
                                        <button class="btn-icon btn-icon-print" title="Print Pass" onclick="printSinglePass(${p.id})">🖨️</button>
                                        <button class="btn-icon btn-icon-delete" title="Revoke & Delete Pass" onclick="deleteBusPass(${p.id}, '${esc(p.pass_number)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="7">No generated bus passes found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function getBusPassHTML(p) {
    const logoUrl = window.location.origin + '/assets/images/vemu-logo.jpg';
    const photoUrl = p.passport_photo ? (p.passport_photo.startsWith("http") ? p.passport_photo : `${API_BASE}${p.passport_photo.startsWith('/') ? '' : '/'}${p.passport_photo}`) : "";
    return `
        <div class="bus-pass-card" style="width: 480px; max-width: 95vw; margin: 0 auto; background: #ffffff; border: 2.5px solid #101B3F; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(16,27,63,0.15); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', Arial, sans-serif; box-sizing: border-box;">
            <div class="pass-card-head" style="background: #101B3F; color: #ffffff; padding: 14px 18px; display: flex; align-items: center; gap: 12px; border-bottom: 3px solid #0EA5E9;">
                <img src="${logoUrl}" alt="VEMU IT" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'44\\' height=\\'44\\' viewBox=\\'0 0 44 44\\'><rect width=\\'44\\' height=\\'44\\' rx=\\'6\\' fill=\\'%232563EB\\'/><text x=\\'22\\' y=\\'28\\' fill=\\'%23ffffff\\' font-size=\\'13\\' font-family=\\'Arial\\' font-weight=\\'bold\\' text-anchor=\\'middle\\'>VEMU</text></svg>';" style="width: 44px; height: 44px; border-radius: 6px; background: #ffffff; padding: 2px; object-fit: contain; flex-shrink: 0;">
                <div class="pass-head-title" style="flex: 1;">
                    <h3 style="font-size: 13px; font-weight: 900; color: #ffffff; letter-spacing: 0.5px; margin: 0 0 3px 0; text-transform: uppercase;">VEMU INSTITUTE OF TECHNOLOGY</h3>
                    <p style="font-size: 9px; color: #EAF2FF; font-weight: 700; margin: 0; letter-spacing: 0.3px;">OFFICIAL STUDENT TRANSPORTATION PASS — 2026-27</p>
                </div>
            </div>
            <div class="pass-card-body" style="padding: 16px 18px; display: grid; grid-template-columns: ${photoUrl ? '76px 1fr 90px' : '1fr 90px'}; gap: 12px; align-items: center; background: #ffffff;">
                ${photoUrl ? `
                    <div class="pass-photo-wrap" style="display: flex; flex-direction: column; align-items: center; justify-content: center;">
                        <img src="${photoUrl}" alt="${esc(p.student_name)}" style="width: 72px; height: 86px; object-fit: cover; border-radius: 8px; border: 2px solid #101B3F; box-shadow: 0 4px 10px rgba(0,0,0,0.12);" onerror="this.parentElement.style.display='none';">
                        <span style="font-size: 8px; font-weight: 800; color: #64748B; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.3px;">PHOTO</span>
                    </div>
                ` : ''}
                <div class="pass-data-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div class="pass-data-item full" style="grid-column: 1 / -1;">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Student Name</label>
                        <strong style="font-size: 13px; color: #101B3F; margin-top: 1px; display: block; font-weight: 800;">${esc(p.student_name)}</strong>
                    </div>
                    <div class="pass-data-item">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Roll Number</label>
                        <strong style="font-size: 11px; color: #101B3F; margin-top: 1px; display: block; font-weight: 700;">${esc(p.roll_no)}</strong>
                    </div>
                    <div class="pass-data-item">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Branch</label>
                        <strong style="font-size: 11px; color: #101B3F; margin-top: 1px; display: block; font-weight: 700;">${esc(p.branch || 'N/A')}</strong>
                    </div>
                    <div class="pass-data-item full" style="grid-column: 1 / -1;">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Route</label>
                        <strong style="font-size: 11px; color: #101B3F; margin-top: 1px; display: block; font-weight: 700;">${esc(p.route_name)}</strong>
                    </div>
                    <div class="pass-data-item">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Pickup Stop</label>
                        <strong style="font-size: 11px; color: #101B3F; margin-top: 1px; display: block; font-weight: 700;">${esc(p.stop_name)}</strong>
                    </div>
                    <div class="pass-data-item">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Assigned Bus</label>
                        <strong style="font-size: 11px; color: #2563EB; margin-top: 1px; display: block; font-weight: 800;">${esc(p.bus_number)}</strong>
                    </div>
                    <div class="pass-data-item">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Pass Number</label>
                        <strong style="font-size: 11px; color: #101B3F; margin-top: 1px; display: block; font-family: monospace; font-weight: 800;">${esc(p.pass_number)}</strong>
                    </div>
                    <div class="pass-data-item">
                        <label style="font-size: 8px; font-weight: 800; text-transform: uppercase; color: #475569; display: block;">Valid Till</label>
                        <strong style="font-size: 11px; color: #101B3F; margin-top: 1px; display: block; font-weight: 700;">${formatDate(p.valid_to)}</strong>
                    </div>
                </div>
                <div class="pass-qr-wrap" style="display: flex; flex-direction: column; align-items: center; justify-content: center; background: #EAF2FF; border: 1.5px dashed #2563EB; border-radius: 8px; padding: 8px; text-align: center;">
                    <div class="qr-box" style="font-size: 8px; font-weight: 900; text-align: center; color: #101B3F; line-height: 1.3;">
                        QR VERIFIED<br>
                        ▣▣▣<br>
                        ${esc(p.pass_number)}
                    </div>
                    <small style="font-size: 8px; margin-top: 4px; color: #2563EB; font-weight: 800;">OFFICIAL PASS</small>
                </div>
            </div>
            <div class="pass-card-foot" style="background: #f8fafc; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: #475569; border-top: 1.5px solid #e2e8f0;">
                <div>
                    <span class="pass-security-seal" style="font-weight: 800; color: #059669; display: block;">✓ Verified Transportation Pass</span>
                    <span style="font-size: 8.5px; color: #64748b;">Carry daily during travel</span>
                </div>
                <div style="text-align: right;">
                    <div style="font-family: 'Brush Script MT', 'Segoe Script', cursive; font-size: 16px; color: #2563EB; font-weight: 700; transform: rotate(-3deg); margin-bottom: -2px;">Trinath</div>
                    <div style="border-top: 1px solid #101B3F; width: 110px;"></div>
                    <span style="font-weight: 800; color: #101B3F; font-size: 8.5px; text-transform: uppercase;">Admin / Transport Officer</span>
                </div>
            </div>
        </div>
    `;
}

function getPaymentReceiptHTML(p) {
    if (!p) return "";
    const receiptNum = `RCP-PAY-${String(p.id || p.payment_id || 0).padStart(6, '0')}`;
    const amountVal = Number(p.amount_paid !== undefined ? p.amount_paid : (p.amount !== undefined ? p.amount : 0));
    const applicableVal = Number(p.applicable_fee || amountVal);
    const payDate = p.payment_date || p.date || p.created_at;
    const payMethod = p.payment_method || p.method || p.payment_mode || 'Online UPI';
    const payRef = p.transaction_id || p.transaction_ref || 'N/A';
    const payStatus = p.payment_status || p.status || 'Verified';

    return `
        <div class="receipt-document" style="width: 100%; max-width: 680px; margin: 0 auto; background: #ffffff; color: #101B3F; border: 2.5px solid #101B3F; border-radius: 14px; padding: 26px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', Arial, sans-serif; box-sizing: border-box; box-shadow: 0 10px 25px rgba(16,27,63,0.08);">
            <!-- HEADER -->
            <div style="border-bottom: 2px solid #101B3F; padding-bottom: 14px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 14px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 52px; height: 52px; border-radius: 8px; border: 2px solid #101B3F; background: #EAF2FF; display: flex; align-items: center; justify-content: center; font-size: 26px; flex-shrink: 0;">
                        🚌
                    </div>
                    <div>
                        <h1 style="font-size: 16px; font-weight: 900; color: #101B3F; margin: 0 0 3px 0; letter-spacing: 0.5px; text-transform: uppercase;">VEMU INSTITUTE OF TECHNOLOGY</h1>
                        <p style="font-size: 10px; color: #475569; margin: 0 0 2px 0; font-weight: 600;">Approved by AICTE, New Delhi &amp; Affiliated to JNTUA</p>
                        <p style="font-size: 10px; color: #475569; margin: 0;">P.Kothakota, Near Pakala, Chittoor Dist, AP - 517112</p>
                    </div>
                </div>
                <div style="text-align: right; border-left: 2px solid #EAF2FF; padding-left: 14px;">
                    <div style="display: inline-block; background: #101B3F; color: #ffffff; font-weight: 800; font-size: 10px; padding: 4px 10px; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">
                        FEE RECEIPT
                    </div>
                    <div style="font-size: 11px; font-weight: 800; color: #2563EB;">ORIGINAL COPY</div>
                </div>
            </div>

            <!-- RECEIPT NUMBER & DATE -->
            <div style="display: flex; justify-content: space-between; align-items: center; background: #EAF2FF; border: 1.5px solid #c7d2fe; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;">
                <div>
                    <span style="font-size: 9px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; display: block;">Receipt Number</span>
                    <strong style="font-size: 13px; font-weight: 900; color: #101B3F; font-family: monospace;">${esc(receiptNum)}</strong>
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 9px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; display: block;">Date &amp; Time</span>
                    <strong style="font-size: 12px; font-weight: 700; color: #101B3F;">${formatDateTime(payDate)}</strong>
                </div>
            </div>

            <!-- STUDENT & BUS TRANSPORT INFORMATION -->
            <div style="border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; background: #ffffff;">
                <div style="font-size: 10px; font-weight: 800; color: #101B3F; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; border-bottom: 1px dashed #cbd5e1; padding-bottom: 4px;">
                    Student &amp; Transportation Details
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 11px;">
                    <div>
                        <span style="color: #64748b; font-weight: 600;">Student Name:</span>
                        <strong style="color: #101B3F; margin-left: 4px;">${esc(p.student_name)}</strong>
                    </div>
                    <div>
                        <span style="color: #64748b; font-weight: 600;">Roll Number:</span>
                        <strong style="color: #101B3F; margin-left: 4px;">${esc(p.roll_no)}</strong>
                    </div>
                    <div>
                        <span style="color: #64748b; font-weight: 600;">Branch / Course:</span>
                        <strong style="color: #101B3F; margin-left: 4px;">${esc(p.branch || 'N/A')}</strong>
                    </div>
                    <div>
                        <span style="color: #64748b; font-weight: 600;">Contact Phone:</span>
                        <strong style="color: #101B3F; margin-left: 4px;">${esc(p.phone || 'N/A')}</strong>
                    </div>
                    <div style="grid-column: 1 / -1;">
                        <span style="color: #64748b; font-weight: 600;">Assigned Route:</span>
                        <strong style="color: #101B3F; margin-left: 4px;">${esc(p.route_name)}</strong>
                    </div>
                    <div style="grid-column: 1 / -1;">
                        <span style="color: #64748b; font-weight: 600;">Boarding Stop:</span>
                        <strong style="color: #101B3F; margin-left: 4px;">${esc(p.stop_name)} ${p.distance_km ? `(${p.distance_km} km)` : ''}</strong>
                    </div>
                </div>
            </div>

            <!-- FEE PARTICULARS TABLE -->
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 11px;">
                <thead>
                    <tr style="background: #101B3F; color: #ffffff;">
                        <th style="padding: 8px 10px; text-align: center; border: 1.5px solid #101B3F; width: 40px;">#</th>
                        <th style="padding: 8px 10px; text-align: left; border: 1.5px solid #101B3F;">Fee Particulars</th>
                        <th style="padding: 8px 10px; text-align: center; border: 1.5px solid #101B3F; width: 100px;">Academic Year</th>
                        <th style="padding: 8px 10px; text-align: right; border: 1.5px solid #101B3F; width: 120px;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: center; font-weight: 700; color: #101B3F;">1</td>
                        <td style="padding: 8px 10px; border: 1px solid #cbd5e1;">
                            <strong style="color: #101B3F; display: block;">Annual College Bus Transportation Fee</strong>
                            <span style="font-size: 10px; color: #64748b;">Route: ${esc(p.route_name)} — Stop: ${esc(p.stop_name)}</span>
                        </td>
                        <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: center; color: #475569; font-weight: 600;">2026 – 2027</td>
                        <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 700; color: #101B3F;">${money(applicableVal)}</td>
                    </tr>
                    <tr style="background: #f8fafc;">
                        <td colspan="3" style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 700; color: #475569;">Total Applicable Bus Fee:</td>
                        <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 700; color: #101B3F;">${money(applicableVal)}</td>
                    </tr>
                    <tr style="background: #EAF2FF;">
                        <td colspan="3" style="padding: 8px 10px; border: 1.5px solid #101B3F; text-align: right; font-weight: 800; color: #101B3F; font-size: 12px;">Amount Paid (Received):</td>
                        <td style="padding: 8px 10px; border: 1.5px solid #101B3F; text-align: right; font-weight: 900; color: #059669; font-size: 13px;">${money(amountVal)}</td>
                    </tr>
                </tbody>
            </table>

            <!-- TRANSACTION DETAILS & VERIFIED BOX -->
            <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 14px; margin-bottom: 20px;">
                <div style="border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; background: #f8fafc; font-size: 10px;">
                    <div style="font-weight: 800; color: #101B3F; text-transform: uppercase; margin-bottom: 6px;">Payment Verification Details</div>
                    <div style="margin-bottom: 3px;"><span style="color: #64748b;">Payment Method:</span> <strong style="color: #101B3F; text-transform: uppercase;">${esc(payMethod)}</strong></div>
                    <div style="margin-bottom: 3px;"><span style="color: #64748b;">Transaction / UTR:</span> <strong style="color: #101B3F; font-family: monospace;">${esc(payRef)}</strong></div>
                    <div style="margin-bottom: 3px;"><span style="color: #64748b;">Status:</span> <strong style="color: ${payStatus === 'Success' ? '#059669' : '#d97706'}; font-weight: 800;">${esc(payStatus)}</strong></div>
                    <div><span style="color: #64748b;">Purpose:</span> <strong>Annual Student Bus Transportation Pass</strong></div>
                </div>
                <div style="border: 1.5px dashed #2563EB; border-radius: 8px; padding: 10px; text-align: center; background: #EAF2FF; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                    <div style="font-size: 9px; font-weight: 900; color: #2563EB; letter-spacing: 0.5px; margin-bottom: 3px;">CAMPUSGO DIGITAL VERIFIED</div>
                    <div style="font-family: monospace; font-size: 11px; font-weight: 800; color: #101B3F; border: 1px solid #c7d2fe; padding: 3px 6px; background: #ffffff; border-radius: 4px;">
                        ${esc(receiptNum)}
                    </div>
                    <div style="font-size: 8px; color: #059669; font-weight: 800; margin-top: 4px;">✓ OFFICIAL VERIFIED RECEIPT</div>
                </div>
            </div>

            <!-- FOOTER & SIGNATURE -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; padding-top: 14px; border-top: 1.5px solid #101B3F; font-size: 10px;">
                <div style="color: #64748b; max-width: 320px;">
                    <p style="margin: 0 0 3px 0; font-size: 9px; font-style: italic;">* This is a computer-generated official receipt valid for college bus boarding and verification.</p>
                    <p style="margin: 0; font-size: 9px; color: #94a3b8;">CampusGo Transport Management System — VEMU IT</p>
                </div>
                <div style="text-align: center;">
                    <div style="height: 30px; display: flex; align-items: center; justify-content: center; font-family: 'Brush Script MT', 'Segoe Script', cursive; font-size: 20px; color: #2563EB; font-weight: 700; transform: rotate(-3deg);">
                        Trinath
                    </div>
                    <div style="border-top: 1.5px solid #101B3F; width: 150px; padding-top: 3px; font-weight: 800; color: #101B3F; font-size: 10px;">
                        Admin / Transport In-charge
                    </div>
                    <div style="font-size: 9px; color: #64748b;">VEMU IT &bull; Authorized Signatory</div>
                </div>
            </div>
        </div>
    `;
}

async function openPassCardModal(passId) {
    try {
        const res = await apiFetch(`/api/admin/bus-passes/${passId}`);
        if (!res.success || !res.pass) throw new Error(res.message || "Pass not found");
        const p = res.pass;
        state.activePass = p;

        const dialog = document.getElementById("passPreviewDialog");
        const printArea = document.getElementById("passPrintArea");
        if (printArea) {
            printArea.innerHTML = getBusPassHTML(p);
        }
        if (dialog) dialog.showModal();
    } catch (err) {
        showToast("Could not load bus pass: " + err.message, "error");
    }
}

function printCurrentPass() {
    if (state.activePass) {
        printPassCardDirect(state.activePass);
    } else {
        showToast("No active bus pass selected for printing.", "warning");
    }
}

async function printSinglePass(passId) {
    try {
        let p = state.busPasses.find(x => x.id === passId);
        if (!p) {
            const res = await apiFetch(`/api/admin/bus-passes/${passId}`);
            if (res && res.pass) p = res.pass;
        }
        if (p) {
            state.activePass = p;
            printPassCardDirect(p);
        } else {
            throw new Error("Could not load pass information.");
        }
    } catch (err) {
        showToast("Print error: " + err.message, "error");
    }
}

function printPassCardDirect(p) {
    if (!p) return;
    state.activePass = p;
    printDocumentDirect(getBusPassHTML(p), `CampusGo_BusPass_${p.pass_number || p.id}`);
}

async function openReceiptModal(paymentId) {
    try {
        let p = state.payments.find(x => x.id === paymentId);
        if (!p) {
            const res = await apiFetch(`/api/admin/payments/${paymentId}`);
            if (res && res.payment) p = res.payment;
        }
        if (!p) throw new Error("Payment record not found.");
        state.activePayment = p;

        const dialog = document.getElementById("receiptPreviewDialog");
        const printArea = document.getElementById("receiptPrintArea");
        if (printArea) {
            printArea.innerHTML = getPaymentReceiptHTML(p);
        }
        if (dialog) dialog.showModal();
    } catch (err) {
        showToast("Could not preview receipt: " + err.message, "error");
    }
}

function printCurrentReceipt() {
    if (state.activePayment) {
        printDocumentDirect(
            getPaymentReceiptHTML(state.activePayment),
            `CampusGo_FeeReceipt_PAY_${state.activePayment.id}`
        );
    } else {
        showToast("No active payment receipt selected for printing.", "warning");
    }
}

async function printPaymentReceipt(paymentId) {
    try {
        let p = state.payments.find(x => x.id === paymentId);
        if (!p) {
            const res = await apiFetch(`/api/admin/payments/${paymentId}`);
            if (res && res.payment) p = res.payment;
        }
        if (!p) throw new Error("Payment record not found.");
        state.activePayment = p;
        printDocumentDirect(
            getPaymentReceiptHTML(p),
            `CampusGo_FeeReceipt_PAY_${p.id}`
        );
    } catch (err) {
        showToast("Print receipt error: " + err.message, "error");
    }
}

function printDocumentDirect(htmlContent, documentTitle = "CampusGo_Document") {
    if (!htmlContent) return;

    // 1. Populate dedicated container in current DOM for manual browser Ctrl+P fallback
    const printContainer = document.getElementById("printOnlyPassContainer");
    if (printContainer) {
        printContainer.innerHTML = htmlContent;
    }

    // 2. Hidden iframe printing technique — 100% reliable, immune to modal top-layer clipping and popup blockers
    try {
        let iframe = document.getElementById("hiddenPrintIframe");
        if (!iframe) {
            iframe = document.createElement("iframe");
            iframe.id = "hiddenPrintIframe";
            iframe.setAttribute("style", "position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden;");
            document.body.appendChild(iframe);
        }

        const iframeWin = iframe.contentWindow;
        const iframeDoc = iframeWin.document;
        iframeDoc.open();
        iframeDoc.write(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>${esc(documentTitle)}</title>
                <style>
                    @page {
                        size: A4 portrait;
                        margin: 10mm;
                    }
                    * {
                        box-sizing: border-box;
                        margin: 0;
                        padding: 0;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                        color-adjust: exact !important;
                    }
                    html, body {
                        background: #ffffff !important;
                        color: #101B3F;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", Arial, sans-serif;
                    }
                    body {
                        padding: 14px;
                        display: flex;
                        justify-content: center;
                        align-items: flex-start;
                        min-height: 100vh;
                        background: #ffffff !important;
                    }
                    table {
                        border-collapse: collapse;
                    }
                    @media print {
                        body {
                            padding: 0 !important;
                        }
                    }
                </style>
            </head>
            <body>
                ${htmlContent}
            </body>
            </html>
        `);
        iframeDoc.close();

        setTimeout(() => {
            try {
                iframeWin.focus();
                iframeWin.print();
            } catch (err) {
                console.warn("Hidden iframe print failed, falling back to window.print():", err);
                window.print();
            }
        }, 320);
    } catch (err) {
        console.error("Iframe printing failed, using fallback:", err);
        window.print();
    }
}

async function deleteBusPass(passId, passNumber) {
    if (!confirm(`Are you sure you want to revoke and delete bus pass ${passNumber}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/bus-passes/${passId}`, { method: "DELETE" });
        showToast(res.message || "Bus pass revoked and removed.", "success");
        await Promise.all([loadBusPasses(), loadStats()]);
    } catch (err) {
        showToast("Failed to delete bus pass: " + err.message, "error");
    }
}

/* =========================================================
   11. LIVE BUS TRACKING
========================================================= */

async function loadLiveTracking() {
    const container = document.getElementById("view-tracking");
    if (!container) return;

    try {
        const res = await apiFetch("/api/admin/live-tracking");
        state.liveBuses = res.buses || [];
        renderLiveTrackingView();
        initOrUpdateMap();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load live tracking: ${esc(err.message)}</div>`;
    }
}

function renderLiveTrackingView() {
    const container = document.getElementById("view-tracking");
    if (!container) return;

    const liveCount = state.liveBuses.filter(b => b.is_live).length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Live Bus Tracking</h1>
                <p class="subtitle">Real-time GPS positions reported by campus bus drivers with Socket.IO updates.</p>
            </div>
            <button class="btn btn-primary" onclick="loadLiveTracking()">⟳ Refresh Locations</button>
        </div>

        <div class="tracking-layout">
            <div class="map-card-wrapper">
                <div class="map-header">
                    <h3><span>◎</span> Real-Time Campus Map</h3>
                    <div>
                        <span class="badge ${liveCount > 0 ? 'ok' : 'muted'}">
                            ${liveCount > 0 ? `<span class="live-pulse"></span> ${liveCount} Bus Active on Trip` : 'No active trips right now'}
                        </span>
                    </div>
                </div>
                <div id="liveMap"></div>
            </div>

            <div class="tracking-sidebar">
                <h3 style="font-size: 14px; font-weight: 700; color: #192957; margin-bottom: 6px;">Campus Fleet (${state.liveBuses.length})</h3>
                ${state.liveBuses.length ? state.liveBuses.map(b => `
                    <div class="bus-live-card" onclick="focusBusOnMap(${b.bus_id})">
                        <div class="bus-live-top">
                            <span class="bus-live-number">${esc(b.bus_number)}</span>
                            ${b.is_live
                                ? `<span class="badge ok"><span class="live-pulse"></span> LIVE</span>`
                                : (b.latitude ? `<span class="badge muted"><span class="stale-dot"></span> Offline</span>` : `<span class="badge muted">No GPS</span>`)}
                        </div>
                        <div class="bus-live-meta">
                            <strong>Driver:</strong> ${esc(b.driver_name)} (${esc(b.driver_phone)})<br>
                            <strong>Route:</strong> ${esc(b.route_name)}<br>
                            <strong>Status:</strong> ${getBadge(b.trip_status)}<br>
                            ${b.latitude ? `<strong>Last update:</strong> ${b.minutes_ago !== null ? `${b.minutes_ago}m ago` : 'Recent'}` : 'Waiting for GPS ping'}
                        </div>
                    </div>
                `).join("") : `<div class="empty-state">No buses recorded.</div>`}
            </div>
        </div>
    `;
}

function initOrUpdateMap() {
    const mapEl = document.getElementById("liveMap");
    if (!mapEl || typeof L === "undefined") return;

    if (!state.map) {
        state.map = L.map("liveMap").setView(COLLEGE_COORDS, 11);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "&copy; OpenStreetMap contributors",
            maxZoom: 18
        }).addTo(state.map);

        // Add College Campus Landmark Marker
        const collegeIcon = L.divIcon({
            className: "college-marker",
            html: `<div style="background:#192957; color:#fff; border:2px solid #ffb703; border-radius:50%; width:32px; height:32px; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:11px; box-shadow:0 4px 12px rgba(0,0,0,0.3);">🏛️</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        L.marker(COLLEGE_COORDS, { icon: collegeIcon })
            .addTo(state.map)
            .bindPopup("<strong>VEMU Institute of Technology</strong><br>P.Kothakota, Chittoor Dist.");
    }

    // Update bus markers
    state.liveBuses.forEach(b => {
        if (!b.latitude || !b.longitude) return;

        const isLive = b.is_live;
        const color = isLive ? "#10b981" : "#64748b";

        const busIcon = L.divIcon({
            className: "bus-marker",
            html: `<div style="background:${color}; color:#fff; border:2px solid #fff; border-radius:10px; padding:3px 7px; font-weight:800; font-size:10px; box-shadow:0 3px 8px rgba(0,0,0,0.25); white-space:nowrap;">🚌 ${esc(b.bus_number)}</div>`,
            iconSize: [60, 24],
            iconAnchor: [30, 12]
        });

        if (state.mapMarkers[b.bus_id]) {
            state.mapMarkers[b.bus_id].setLatLng([b.latitude, b.longitude]);
            state.mapMarkers[b.bus_id].setIcon(busIcon);
        } else {
            const marker = L.marker([b.latitude, b.longitude], { icon: busIcon })
                .addTo(state.map)
                .bindPopup(`
                    <strong>${esc(b.bus_number)}</strong> (${esc(b.bus_name || 'Campus Bus')})<br>
                    <strong>Driver:</strong> ${esc(b.driver_name)}<br>
                    <strong>Route:</strong> ${esc(b.route_name)}<br>
                    <strong>Trip:</strong> ${esc(b.trip_status)}<br>
                    <strong>Last Recorded:</strong> ${formatDateTime(b.recorded_at)}
                `);
            state.mapMarkers[b.bus_id] = marker;
        }
    });

    setTimeout(() => {
        state.map?.invalidateSize();
    }, 200);
}

function focusBusOnMap(busId) {
    const b = state.liveBuses.find(x => x.bus_id === busId);
    if (!b || !b.latitude || !b.longitude || !state.map) {
        showToast("No GPS coordinates recorded for this bus yet.", "info");
        return;
    }
    state.map.setView([b.latitude, b.longitude], 14, { animate: true });
    state.mapMarkers[busId]?.openPopup();
}

/* =========================================================
   12. REPORTS & ANALYTICS
========================================================= */

async function loadReports() {
    const container = document.getElementById("view-reports");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Generating college transportation analytics report...</div>`;

    try {
        const res = await apiFetch("/api/admin/reports/summary");
        state.reports = res;
        renderReportsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load reports: ${esc(err.message)}</div>`;
    }
}

function printOfficialReport() {
    if (!state.reports) {
        showToast("Reports data not loaded yet.", "warning");
        return;
    }
    const reportHtml = getOfficialReportHTML(state.reports);
    printDocumentDirect(reportHtml, "VEMU_IT_Transportation_Analytics_Report");
}

function getOfficialReportHTML(reports) {
    if (!reports) return "";
    const { fleet, route_load, revenue, payroll } = reports;
    const nowStr = formatDateTime(new Date());

    return `
        <div class="report-document" style="width: 100%; max-width: 780px; margin: 0 auto; background: #ffffff; color: #101B3F; border: 2.5px solid #101B3F; border-radius: 14px; padding: 26px 30px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', Arial, sans-serif; box-sizing: border-box;">
            <!-- INSTITUTION HEADER -->
            <div style="border-bottom: 2px solid #101B3F; padding-bottom: 14px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 14px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 52px; height: 52px; border-radius: 8px; border: 2px solid #101B3F; background: #EAF2FF; display: flex; align-items: center; justify-content: center; font-size: 26px; flex-shrink: 0;">
                        🚌
                    </div>
                    <div>
                        <h1 style="font-size: 16px; font-weight: 900; color: #101B3F; margin: 0 0 3px 0; letter-spacing: 0.5px; text-transform: uppercase;">VEMU INSTITUTE OF TECHNOLOGY</h1>
                        <p style="font-size: 10px; color: #475569; margin: 0 0 2px 0; font-weight: 600;">Approved by AICTE, New Delhi &amp; Affiliated to JNTUA, Ananthapuramu</p>
                        <p style="font-size: 10px; color: #475569; margin: 0;">P.Kothakota, Near Pakala, Chittoor District, AP - 517112</p>
                    </div>
                </div>
                <div style="text-align: right; border-left: 2px solid #EAF2FF; padding-left: 14px;">
                    <div style="display: inline-block; background: #101B3F; color: #ffffff; font-weight: 800; font-size: 10px; padding: 4px 10px; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">
                        ANALYTICS REPORT
                    </div>
                    <div style="font-size: 11px; font-weight: 800; color: #2563EB;">ACADEMIC YEAR 2026-27</div>
                </div>
            </div>

            <!-- REPORT TITLE & METADATA -->
            <div style="display: flex; justify-content: space-between; align-items: center; background: #EAF2FF; border: 1.5px solid #c7d2fe; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;">
                <div>
                    <h2 style="font-size: 13px; font-weight: 900; color: #101B3F; margin: 0 0 2px 0; text-transform: uppercase;">Campus Transportation &amp; Fleet Analytics</h2>
                    <span style="font-size: 10px; color: #475569;">Generated via CampusGo Administration Portal</span>
                </div>
                <div style="text-align: right;">
                    <span style="font-size: 9px; font-weight: 800; color: #475569; text-transform: uppercase; display: block;">Report Date &amp; Time</span>
                    <strong style="font-size: 12px; font-weight: 700; color: #101B3F;">${nowStr}</strong>
                </div>
            </div>

            <!-- 3 METRIC BOXES -->
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 18px;">
                <!-- Fleet Readiness -->
                <div style="border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #ffffff;">
                    <div style="font-size: 10px; font-weight: 800; color: #101B3F; text-transform: uppercase; border-bottom: 1.5px solid #EAF2FF; padding-bottom: 4px; margin-bottom: 8px;">
                        🚌 Fleet Readiness
                    </div>
                    <div style="font-size: 10px; display: flex; flex-direction: column; gap: 5px;">
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Total Fleet:</span> <strong>${fleet?.total_buses || 0} buses</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">On Road:</span> <strong style="color: #059669;">${fleet?.working_buses || 0} buses</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Maintenance:</span> <strong style="color: #dc2626;">${fleet?.not_working_buses || 0} buses</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Total Capacity:</span> <strong>${fleet?.total_capacity || 0} seats</strong></div>
                    </div>
                </div>

                <!-- Fee Revenue -->
                <div style="border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #ffffff;">
                    <div style="font-size: 10px; font-weight: 800; color: #101B3F; text-transform: uppercase; border-bottom: 1.5px solid #EAF2FF; padding-bottom: 4px; margin-bottom: 8px;">
                        💰 Fee Revenue
                    </div>
                    <div style="font-size: 10px; display: flex; flex-direction: column; gap: 5px;">
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Collected Fee:</span> <strong style="color: #059669;">${money(revenue?.total_collected)}</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Pending Verify:</span> <strong style="color: #d97706;">${money(revenue?.pending_verification)}</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Success Count:</span> <strong>${revenue?.successful_count || 0}</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Pending Count:</span> <strong>${revenue?.pending_count || 0}</strong></div>
                    </div>
                </div>

                <!-- Driver & Payroll -->
                <div style="border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #ffffff;">
                    <div style="font-size: 10px; font-weight: 800; color: #101B3F; text-transform: uppercase; border-bottom: 1.5px solid #EAF2FF; padding-bottom: 4px; margin-bottom: 8px;">
                        👨‍✈️ Driver Staff
                    </div>
                    <div style="font-size: 10px; display: flex; flex-direction: column; gap: 5px;">
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Registered:</span> <strong>${payroll?.total_drivers || 0} drivers</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Active Duty:</span> <strong style="color: #059669;">${payroll?.active_drivers || 0} drivers</strong></div>
                        <div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">Monthly Payroll:</span> <strong style="color: #2563EB;">${money(payroll?.monthly_payroll)}</strong></div>
                    </div>
                </div>
            </div>

            <!-- ROUTE OCCUPANCY TABLE -->
            <div style="margin-bottom: 20px;">
                <div style="font-size: 11px; font-weight: 800; color: #101B3F; text-transform: uppercase; margin-bottom: 8px; border-bottom: 1.5px solid #101B3F; padding-bottom: 4px;">
                    Route-wise Student Occupancy &amp; Bus Assignment
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
                    <thead>
                        <tr style="background: #101B3F; color: #ffffff;">
                            <th style="padding: 7px 10px; text-align: left; border: 1.5px solid #101B3F;">Route Name</th>
                            <th style="padding: 7px 10px; text-align: center; border: 1.5px solid #101B3F; width: 100px;">Active Stops</th>
                            <th style="padding: 7px 10px; text-align: left; border: 1.5px solid #101B3F;">Assigned Buses</th>
                            <th style="padding: 7px 10px; text-align: right; border: 1.5px solid #101B3F; width: 140px;">Registered Students</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(route_load || []).length ? route_load.map(r => `
                            <tr>
                                <td style="padding: 7px 10px; border: 1px solid #cbd5e1; font-weight: 700; color: #101B3F;">${esc(r.route_name)}</td>
                                <td style="padding: 7px 10px; border: 1px solid #cbd5e1; text-align: center;">${r.stop_count} stops</td>
                                <td style="padding: 7px 10px; border: 1px solid #cbd5e1; font-weight: 700; color: #2563EB;">${esc(r.buses || 'Unassigned')}</td>
                                <td style="padding: 7px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 800; color: #101B3F;">${r.student_count} students</td>
                            </tr>
                        `).join("") : `
                            <tr>
                                <td colspan="4" style="padding: 10px; text-align: center; border: 1px solid #cbd5e1; color: #64748b;">No route occupancy data available.</td>
                            </tr>
                        `}
                    </tbody>
                </table>
            </div>

            <!-- FOOTER & SIGNATURE -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; padding-top: 14px; border-top: 1.5px solid #101B3F; font-size: 10px;">
                <div style="color: #64748b; max-width: 360px;">
                    <p style="margin: 0 0 3px 0; font-size: 9px; font-style: italic;">* Official system analytics report compiled from live database records for administrative inspection and auditing.</p>
                    <p style="margin: 0; font-size: 9px; color: #94a3b8;">CampusGo Transport Management System — VEMU IT</p>
                </div>
                <div style="text-align: center;">
                    <div style="height: 28px; display: flex; align-items: center; justify-content: center; font-family: 'Brush Script MT', 'Segoe Script', cursive; font-size: 19px; color: #2563EB; font-weight: 700; transform: rotate(-3deg);">
                        Trinath
                    </div>
                    <div style="border-top: 1.5px solid #101B3F; width: 160px; padding-top: 3px; font-weight: 800; color: #101B3F; font-size: 10px;">
                        Admin / Transport Officer
                    </div>
                    <div style="font-size: 9px; color: #64748b;">VEMU IT &bull; Authorized Signatory</div>
                </div>
            </div>
        </div>
    `;
}

function renderReportsView() {
    const container = document.getElementById("view-reports");
    if (!container || !state.reports) return;

    const { fleet, route_load, revenue, payroll } = state.reports;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Transportation Reports &amp; Analytics</h1>
                <p class="subtitle">Comprehensive fleet utilization, student load distribution and revenue breakdown.</p>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-primary" onclick="printOfficialReport()">🖨️ Print Official Report</button>
            </div>
        </div>

        <div class="reports-grid">
            <div class="report-summary-box">
                <h3><span>▰</span> Fleet Readiness</h3>
                <div class="report-metric-row"><span>Total Fleet Size</span><strong>${fleet.total_buses || 0} buses</strong></div>
                <div class="report-metric-row"><span>Working / On Road</span><strong style="color:#059669;">${fleet.working_buses || 0} buses</strong></div>
                <div class="report-metric-row"><span>Maintenance / Repair</span><strong style="color:#dc2626;">${fleet.not_working_buses || 0} buses</strong></div>
                <div class="report-metric-row"><span>Total Seating Capacity</span><strong>${fleet.total_capacity || 0} seats</strong></div>
            </div>

            <div class="report-summary-box">
                <h3><span>₹</span> Fee Revenue Collection</h3>
                <div class="report-metric-row"><span>Collected Revenue</span><strong style="color:#059669;">${money(revenue.total_collected)}</strong></div>
                <div class="report-metric-row"><span>Pending Verification</span><strong style="color:#d97706;">${money(revenue.pending_verification)}</strong></div>
                <div class="report-metric-row"><span>Successful Payments</span><strong>${revenue.successful_count || 0}</strong></div>
                <div class="report-metric-row"><span>Pending Verifications</span><strong>${revenue.pending_count || 0}</strong></div>
            </div>

            <div class="report-summary-box">
                <h3><span>♧</span> Driver Staff &amp; Payroll</h3>
                <div class="report-metric-row"><span>Total Registered Drivers</span><strong>${payroll.total_drivers || 0}</strong></div>
                <div class="report-metric-row"><span>Active Drivers</span><strong>${payroll.active_drivers || 0}</strong></div>
                <div class="report-metric-row"><span>Monthly Payroll Commitment</span><strong>${money(payroll.monthly_payroll)}</strong></div>
            </div>
        </div>

        <div class="table-card">
            <div class="table-toolbar">
                <h3>Route Student Occupancy Load</h3>
                <span class="subtitle">${(route_load || []).length} routes</span>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Route Name</th>
                            <th>Active Stops</th>
                            <th>Assigned Buses</th>
                            <th>Registered Students</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(route_load || []).length ? route_load.map(r => `
                            <tr>
                                <td><strong>${esc(r.route_name)}</strong></td>
                                <td>${r.stop_count} stops</td>
                                <td><strong>${esc(r.buses || 'Unassigned')}</strong></td>
                                <td><strong style="color: #315bea; font-size: 13px;">${r.student_count} students</strong></td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="4">No route occupancy data available.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

/* =========================================================
   GENERIC DETAILS MODAL & FORM MODAL HANDLER
========================================================= */

function openDetailsModal(title, items, customActionHtml = "") {
    const dialog = document.getElementById("detailsDialog");
    if (!dialog) return;

    document.getElementById("detTitle").textContent = title;
    document.getElementById("detBody").innerHTML = `
        <div class="details-table-wrap">
            ${items.map(it => `
                <div class="detail-row">
                    <label>${esc(it.label)}</label>
                    <strong>${it.value}</strong>
                </div>
            `).join("")}
        </div>
    `;
    const actionSlot = document.getElementById("detCustomAction");
    if (actionSlot) {
        actionSlot.innerHTML = customActionHtml || "";
    }
    dialog.showModal();
}

function closeDetailsModal() {
    const dialog = document.getElementById("detailsDialog");
    if (dialog?.open) dialog.close();
}

function closePassPreviewModal() {
    const dialog = document.getElementById("passPreviewDialog");
    if (dialog?.open) dialog.close();
}

function closeReceiptPreviewModal() {
    const dialog = document.getElementById("receiptPreviewDialog");
    if (dialog?.open) dialog.close();
}

function closeFormModal() {
    const dialog = document.getElementById("formDialog");
    if (dialog?.open) dialog.close();
}

// Global form submit router
document.getElementById("dlgForm")?.addEventListener("submit", async function (e) {
    e.preventDefault();
    const formData = new FormData(this);
    const data = Object.fromEntries(formData.entries());
    const action = data.action_type;

    try {
        if (action === "approve_driver") {
            const reqId = data.request_id;
            await apiFetch(`/api/admin/driver-requests/${reqId}/status`, {
                method: "PATCH",
                body: JSON.stringify({
                    status: "Approved",
                    salary: Number(data.salary),
                    experience: Number(data.experience)
                })
            });
            showToast("Driver approved successfully!", "success");
            closeFormModal();
            await Promise.all([loadDriverRequests(), loadDrivers(), loadStats()]);
        }
        else if (action === "add_student") {
            const pwd = data.password;
            const cpwd = data.confirm_password;
            if (pwd && cpwd && pwd !== cpwd) {
                showToast("Passwords do not match.", "error");
                return;
            }
            if (pwd && pwd.length < 8) {
                showToast("Password must contain at least 8 characters.", "error");
                return;
            }

            if (!data.bus_id && data.route_id) {
                try {
                    const [routesRes, busesRes] = await Promise.all([
                        apiFetch("/api/routes").catch(() => ({ routes: [] })),
                        apiFetch("/api/buses").catch(() => ({ buses: [] }))
                    ]);
                    const rMatch = (routesRes.routes || []).find(r => String(r.route_id) === String(data.route_id));
                    if (rMatch && rMatch.bus_number) {
                        const bMatch = (busesRes.buses || []).find(b => (b.bus_number || '').toUpperCase() === (rMatch.bus_number || '').toUpperCase());
                        if (bMatch) data.bus_id = bMatch.bus_id;
                    }
                } catch (_) {}
            }

            await apiFetch("/api/admin/students", {
                method: "POST",
                body: JSON.stringify(data)
            });
            showToast("Student registered successfully!", "success");
            closeFormModal();
            await Promise.all([loadStudents(), loadStats()]);
        }
        else if (action === "add_driver") {
            const pwd = formData.get("password");
            const cpwd = formData.get("confirm_password");
            if (pwd && cpwd && pwd !== cpwd) {
                showToast("Passwords do not match.", "error");
                return;
            }
            if (pwd && pwd.length < 8) {
                showToast("Password must contain at least 8 characters.", "error");
                return;
            }

            const licenseFile = formData.get("license_photo");
            if (!licenseFile || !(licenseFile instanceof File) || licenseFile.size === 0) {
                showToast("Please upload driving licence photo.", "error");
                return;
            }
            if (licenseFile.size > 5 * 1024 * 1024) {
                showToast("Driving licence photo exceeds 5 MB limit.", "error");
                return;
            }

            const response = await fetch(`${API_BASE}/api/admin/drivers`, {
                method: "POST",
                body: formData
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.message || "Failed to register driver.");
            }

            showToast(result.message || "Driver registered successfully!", "success");
            closeFormModal();
            await Promise.all([loadDrivers(), loadDriverRequests(), loadStats()]);
        }
        else if (action === "edit_student") {
            const stuId = data.student_id;
            await apiFetch(`/api/admin/students/${stuId}`, {
                method: "PUT",
                body: JSON.stringify(data)
            });
            showToast("Student updated successfully!", "success");
            closeFormModal();
            await Promise.all([loadStudents(), loadStats()]);
        }
        else if (action === "edit_driver") {
            const drvId = data.driver_id;
            await apiFetch(`/api/admin/drivers/${drvId}`, {
                method: "PUT",
                body: JSON.stringify(data)
            });
            showToast("Driver details updated successfully!", "success");
            closeFormModal();
            await Promise.all([loadDrivers(), loadStats()]);
        }
        else if (action === "assign_bus_to_driver") {
            const drvId = data.driver_id;
            await apiFetch(`/api/admin/drivers/${drvId}/assign-bus`, {
                method: "POST",
                body: JSON.stringify({ bus_id: data.bus_id })
            });
            showToast("Bus assigned to driver successfully!", "success");
            closeFormModal();
            await Promise.all([loadDrivers(), loadBuses(), loadStats()]);
        }
        else if (action === "add_bus") {
            await apiFetch("/api/admin/buses", {
                method: "POST",
                body: JSON.stringify(data)
            });
            showToast("Bus created successfully!", "success");
            closeFormModal();
            await Promise.all([loadBuses(), loadStats()]);
        }
        else if (action === "edit_bus") {
            const busId = data.bus_id;
            await apiFetch(`/api/admin/buses/${busId}`, {
                method: "PUT",
                body: JSON.stringify(data)
            });
            showToast("Bus updated successfully!", "success");
            closeFormModal();
            await Promise.all([loadBuses(), loadStats()]);
        }
        else if (action === "assign_driver_to_bus") {
            const busId = data.bus_id;
            await apiFetch(`/api/admin/buses/${busId}/assign`, {
                method: "POST",
                body: JSON.stringify({ driver_id: data.driver_id })
            });
            showToast("Driver assignment updated!", "success");
            closeFormModal();
            await Promise.all([loadBuses(), loadDrivers(), loadStats()]);
        }
        else if (action === "add_route") {
            await apiFetch("/api/admin/routes", {
                method: "POST",
                body: JSON.stringify(data)
            });
            showToast("Route created successfully!", "success");
            closeFormModal();
            await Promise.all([loadRoutes(), loadStats()]);
        }
        else if (action === "edit_route") {
            const routeId = data.route_id;
            await apiFetch(`/api/admin/routes/${routeId}`, {
                method: "PUT",
                body: JSON.stringify(data)
            });
            showToast("Route updated successfully!", "success");
            closeFormModal();
            await Promise.all([loadRoutes(), loadStats()]);
        }
        else if (action === "add_stop_to_route") {
            const routeId = data.route_id;
            await apiFetch(`/api/admin/routes/${routeId}/stops`, {
                method: "POST",
                body: JSON.stringify(data)
            });
            showToast("Stop added to route successfully!", "success");
            closeFormModal();
            await selectRoute(routeId);
            await loadRoutes();
        }
        else if (action === "edit_stop") {
            const stopId = data.stop_id;
            await apiFetch(`/api/admin/stops/${stopId}`, {
                method: "PUT",
                body: JSON.stringify(data)
            });
            showToast("Stop distance and fee updated!", "success");
            closeFormModal();
            if (state.selectedRouteId) await selectRoute(state.selectedRouteId);
            await Promise.all([loadRoutes(), loadFeeAssignments()]);
        }
        else if (action === "adjust_stop_fee") {
            const stopId = data.stop_id;
            await apiFetch(`/api/admin/fee-assignments/${stopId}`, {
                method: "PUT",
                body: JSON.stringify({ amount: Number(data.amount) })
            });
            showToast("Stop fee updated successfully!", "success");
            closeFormModal();
            await Promise.all([loadFeeAssignments(), loadStudents(), loadStats()]);
        }
    } catch (err) {
        showToast("Action failed: " + err.message, "error");
    }
});

/* =========================================================
   13. BUS PASS & TRANSPORT CANCELLATIONS
========================================================= */

async function loadCancellations() {
    const container = document.getElementById("view-cancellations");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading transportation cancellation requests...</div>`;

    try {
        const res = await apiFetch("/api/admin/cancellations");
        state.cancellations = res.cancellations || [];

        const pendingCount = state.cancellations.filter(c => c.status === "Pending").length;
        const navBadge = document.getElementById("navCancellations");
        if (navBadge) {
            navBadge.textContent = pendingCount;
            navBadge.hidden = pendingCount === 0;
        }

        renderCancellationsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load cancellations: ${esc(err.message)}</div>`;
    }
}

function renderCancellationsView() {
    const container = document.getElementById("view-cancellations");
    if (!container) return;

    const filter = state.filters.cancellationsStatus || "All";
    const query = state.searchQuery.toLowerCase();

    const rows = state.cancellations.filter(c => {
        const matchesFilter = filter === "All" || c.status === filter;
        const matchesSearch = !query ||
            (c.student_name && c.student_name.toLowerCase().includes(query)) ||
            (c.roll_no && c.roll_no.toLowerCase().includes(query)) ||
            (c.pass_number && c.pass_number.toLowerCase().includes(query)) ||
            (c.route_name && c.route_name.toLowerCase().includes(query)) ||
            (c.bus_number && c.bus_number.toLowerCase().includes(query)) ||
            (c.reason && c.reason.toLowerCase().includes(query));
        return matchesFilter && matchesSearch;
    });

    const pendingCount = state.cancellations.filter(c => c.status === "Pending").length;
    const approvedCount = state.cancellations.filter(c => c.status === "Approved").length;
    const rejectedCount = state.cancellations.filter(c => c.status === "Rejected").length;
    const totalFines = state.cancellations
        .filter(c => c.status === "Approved")
        .reduce((sum, c) => sum + Number(c.fine_amount || 0), 0);

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Bus Pass &amp; Transport Cancellations</h1>
                <p class="subtitle">Review student cancellation requests, enforce institutional cancellation fines (₹500.00 standard), and deactivate bus passes.</p>
            </div>
        </div>

        <div class="summary-strip">
            <div class="summary-item"><strong>${pendingCount}</strong><span>Pending Review</span></div>
            <div class="summary-item"><strong>${approvedCount}</strong><span>Approved (Cancelled)</span></div>
            <div class="summary-item"><strong>${rejectedCount}</strong><span>Rejected</span></div>
            <div class="summary-item"><strong>${money(totalFines)}</strong><span>Total Fines Imposed</span></div>
        </div>

        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    ${["All", "Pending", "Approved", "Rejected"].map(v =>
                        `<button type="button" class="chip ${filter === v ? 'active' : ''}" onclick="setFilter('cancellationsStatus', '${v}')">${v}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} request${rows.length === 1 ? '' : 's'} shown</span>
            </div>

            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>Bus &amp; Route</th>
                            <th>Pass Number</th>
                            <th>Request Date</th>
                            <th>Reason</th>
                            <th>Fine Applied</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(r => `
                            <tr>
                                <td>
                                    <strong>${esc(r.student_name)}</strong>
                                    <small>${esc(r.roll_no)} • ${esc(r.branch || '')} ${r.year ? 'Yr ' + r.year : ''}</small>
                                </td>
                                <td>
                                    <strong>${esc(r.bus_number || 'N/A')}</strong>
                                    <small>${esc(r.route_name || 'N/A')}${r.stop_name ? ' (' + esc(r.stop_name) + ')' : ''}</small>
                                </td>
                                <td><code>${esc(r.pass_number || 'N/A')}</code></td>
                                <td>${formatDate(r.requested_at)}</td>
                                <td>
                                    <div style="max-width: 200px; font-size: 12px; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(r.reason)}">
                                        ${esc(r.reason)}
                                    </div>
                                </td>
                                <td>
                                    ${r.status === 'Approved'
                                        ? `<strong style="color: #059669;">${money(r.fine_amount)}</strong> <span class="badge ${r.fine_payment_status === 'Paid' ? 'ok' : 'bad'}" style="font-size:10px; margin-left:4px;">${r.fine_payment_status === 'Paid' ? 'Paid' : 'Unpaid'}</span>`
                                        : (r.status === 'Pending' ? `<span style="color:#64748b; font-size:11.5px;">₹500 (Standard)</span>` : '—')}
                                </td>
                                <td>${getBadge(r.status)}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewCancellationDetails(${r.cancellation_id})">👁️</button>
                                        ${r.status === 'Pending' ? `
                                            <button class="btn-icon btn-icon-success" title="Approve with Fine" onclick="openApproveCancelModal(${r.cancellation_id})">✓</button>
                                            <button class="btn-icon btn-icon-delete" title="Reject Request" onclick="openRejectCancelModal(${r.cancellation_id})">✕</button>
                                        ` : ''}
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="8">No cancellation requests found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function viewCancellationDetails(id) {
    const r = state.cancellations.find(x => x.cancellation_id === id);
    if (!r) return;
    openDetailsModal("Cancellation Request Details", [
        { label: "Request ID", value: `#CAN-${r.cancellation_id}` },
        { label: "Student Name", value: r.student_name },
        { label: "Roll Number", value: r.roll_no },
        { label: "Branch & Year", value: `${r.branch || ''} ${r.year ? 'Year ' + r.year : ''}` },
        { label: "Assigned Bus", value: r.bus_number || "N/A" },
        { label: "Route & Stop", value: `${r.route_name || 'N/A'} - ${r.stop_name || 'N/A'}` },
        { label: "Bus Pass Number", value: r.pass_number || "N/A" },
        { label: "Request Date", value: formatDateTime(r.requested_at) },
        { label: "Student Reason", value: r.reason },
        { label: "Approval Status", value: getBadge(r.status) },
        { label: "Cancellation Fine", value: r.status === 'Approved' ? money(r.fine_amount) : (r.status === 'Pending' ? "₹500.00 (Pending Approval)" : "No Fine") },
        { label: "Fine Payment Status", value: r.status === 'Approved' ? (r.fine_payment_status === 'Paid' ? `<span class="badge ok">Paid in Full (${r.fine_transaction_id || 'Online UPI'})</span>` : `<span class="badge bad">Pending Payment</span>`) : "N/A" },
        { label: "Admin Remarks", value: r.admin_remarks || "None recorded" },
        { label: "Reviewed At", value: r.reviewed_at ? formatDateTime(r.reviewed_at) : "Pending Review" }
    ]);
}

function openApproveCancelModal(id) {
    const r = state.cancellations.find(x => x.cancellation_id === id);
    if (!r) return;

    document.getElementById("approveCancelId").value = id;
    document.getElementById("approveFineAmount").value = 500;
    document.getElementById("approveRemarks").value = "Approved as per VEMU IT transport rules. Fine applied.";
    document.getElementById("approveCancelSummary").innerHTML = `
        <div><strong>Student:</strong> ${esc(r.student_name)} (${esc(r.roll_no)})</div>
        <div><strong>Bus / Route:</strong> ${esc(r.bus_number || 'N/A')} — ${esc(r.route_name || 'N/A')}</div>
        <div><strong>Bus Pass:</strong> <code>${esc(r.pass_number || 'N/A')}</code></div>
        <div style="margin-top:6px; color:#475569;"><strong>Reason:</strong> ${esc(r.reason)}</div>
    `;

    const dialog = document.getElementById("approveCancelDialog");
    if (dialog) dialog.showModal();
}

function closeApproveCancelModal() {
    const dialog = document.getElementById("approveCancelDialog");
    if (dialog) dialog.close();
}

function openRejectCancelModal(id) {
    const r = state.cancellations.find(x => x.cancellation_id === id);
    if (!r) return;

    document.getElementById("rejectCancelId").value = id;
    document.getElementById("rejectRemarks").value = "";
    document.getElementById("rejectCancelSummary").innerHTML = `
        <div><strong>Student:</strong> ${esc(r.student_name)} (${esc(r.roll_no)})</div>
        <div><strong>Bus Pass:</strong> <code>${esc(r.pass_number || 'N/A')}</code></div>
        <div style="margin-top:6px; color:#475569;"><strong>Reason:</strong> ${esc(r.reason)}</div>
    `;

    const dialog = document.getElementById("rejectCancelDialog");
    if (dialog) dialog.showModal();
}

function closeRejectCancelModal() {
    const dialog = document.getElementById("rejectCancelDialog");
    if (dialog) dialog.close();
}

// Approval and rejection form submission listeners
document.getElementById("approveCancelForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    const id = document.getElementById("approveCancelId").value;
    const fineAmount = document.getElementById("approveFineAmount").value;
    const remarks = document.getElementById("approveRemarks").value;
    const btn = document.getElementById("btnConfirmApproveCancel");

    try {
        if (btn) btn.disabled = true;
        const res = await apiFetch(`/api/admin/cancellations/${id}/approve`, {
            method: "POST",
            body: JSON.stringify({
                fine_amount: Number(fineAmount || 500),
                admin_remarks: remarks
            })
        });

        showToast(res.message || "Cancellation approved and fine applied.", "success");
        closeApproveCancelModal();
        await Promise.all([loadCancellations(), loadStudents(), loadBusPasses(), loadStats()]);
    } catch (err) {
        showToast("Approval failed: " + err.message, "error");
    } finally {
        if (btn) btn.disabled = false;
    }
});

document.getElementById("rejectCancelForm")?.addEventListener("submit", async function(e) {
    e.preventDefault();
    const id = document.getElementById("rejectCancelId").value;
    const remarks = document.getElementById("rejectRemarks").value;
    const btn = document.getElementById("btnConfirmRejectCancel");

    try {
        if (btn) btn.disabled = true;
        const res = await apiFetch(`/api/admin/cancellations/${id}/reject`, {
            method: "POST",
            body: JSON.stringify({
                admin_remarks: remarks
            })
        });

        showToast(res.message || "Cancellation rejected. Pass remains active.", "info");
        closeRejectCancelModal();
        await loadCancellations();
    } catch (err) {
        showToast("Rejection failed: " + err.message, "error");
    } finally {
        if (btn) btn.disabled = false;
    }
});


/* =========================================================
   14. FLEET DIESEL REFUELLING RECORDS
========================================================= */

async function loadDieselRecords() {
    const container = document.getElementById("view-diesel");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading fleet diesel records...</div>`;

    try {
        const res = await apiFetch("/api/admin/diesel");
        state.dieselRecords = res.records || [];
        state.dieselStats = res.summary || {};
        renderDieselView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load diesel records: ${esc(err.message)}</div>`;
    }
}

function renderDieselView() {
    const container = document.getElementById("view-diesel");
    if (!container) return;

    const filterBus = state.filters.dieselBus || "All";
    const query = state.searchQuery.toLowerCase();

    const uniqueBuses = Array.from(new Set(state.dieselRecords.map(r => r.bus_number).filter(Boolean)));

    const rows = state.dieselRecords.filter(r => {
        const matchesBus = filterBus === "All" || r.bus_number === filterBus;
        const matchesSearch = !query ||
            (r.bus_number && r.bus_number.toLowerCase().includes(query)) ||
            (r.driver_name && r.driver_name.toLowerCase().includes(query)) ||
            (r.driver_phone && r.driver_phone.toLowerCase().includes(query)) ||
            (r.notes && r.notes.toLowerCase().includes(query));
        return matchesBus && matchesSearch;
    });

    const totalLitres = state.dieselStats.totalLitres || rows.reduce((s, r) => s + Number(r.litres || 0), 0);
    const totalCost = state.dieselStats.totalCost || rows.reduce((s, r) => s + Number(r.cost || 0), 0);
    const totalEntries = state.dieselStats.totalEntries || state.dieselRecords.length;
    const avgCostPerLitre = totalLitres > 0 ? (totalCost / totalLitres).toFixed(2) : 0;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Fleet Diesel Records</h1>
                <p class="subtitle">Complete fuel consumption log and expenditure records entered directly by authorized VEMU IT bus drivers.</p>
            </div>
        </div>

        <div class="diesel-metric-strip">
            <div class="diesel-card">
                <span class="diesel-label">Total Diesel Filled</span>
                <span class="diesel-val" style="color: #0284c7;">${Number(totalLitres).toFixed(1)} L</span>
            </div>
            <div class="diesel-card">
                <span class="diesel-label">Total Fuel Expenditure</span>
                <span class="diesel-val" style="color: #059669;">${money(totalCost)}</span>
            </div>
            <div class="diesel-card">
                <span class="diesel-label">Refuelling Events</span>
                <span class="diesel-val" style="color: #6366f1;">${totalEntries}</span>
            </div>
            <div class="diesel-card">
                <span class="diesel-label">Avg Rate / Litre</span>
                <span class="diesel-val" style="color: #d97706;">${totalLitres > 0 ? '₹' + avgCostPerLitre : '—'}</span>
            </div>
        </div>

        <div class="table-card">
            <div class="table-toolbar">
                <div class="chips">
                    <button type="button" class="chip ${filterBus === 'All' ? 'active' : ''}" onclick="setFilter('dieselBus', 'All')">All Buses</button>
                    ${uniqueBuses.map(b =>
                        `<button type="button" class="chip ${filterBus === b ? 'active' : ''}" onclick="setFilter('dieselBus', '${b}')">${esc(b)}</button>`
                    ).join("")}
                </div>
                <span class="subtitle">${rows.length} record${rows.length === 1 ? '' : 's'} shown</span>
            </div>

            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Refuel Date &amp; Time</th>
                            <th>Bus Number</th>
                            <th>Driver</th>
                            <th>Fuel Quantity</th>
                            <th>Total Cost</th>
                            <th>Odometer / Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(r => `
                            <tr>
                                <td>${formatDateTime(r.entry_date)}</td>
                                <td><span class="badge ok">${esc(r.bus_number)}</span></td>
                                <td>
                                    <strong>${esc(r.driver_name)}</strong>
                                    <small>📞 ${esc(r.driver_phone || 'N/A')}</small>
                                </td>
                                <td><strong style="color: #0284c7; font-size: 14px;">${Number(r.litres).toFixed(1)} L</strong></td>
                                <td><strong style="color: #059669;">${r.cost ? money(r.cost) : '—'}</strong></td>
                                <td><span style="color: #475569; font-size: 12.5px;">${esc(r.notes || '—')}</span></td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="6">No diesel records logged yet.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}


/* =========================================================
   15. NOTIFICATIONS & VOICE DICTATION CENTER
========================================================= */

let speechRecognitionInstance = null;
let isRecordingVoice = false;
let voiceBaseText = "";
let sessionFinalTranscript = "";

async function loadAdminNotifications() {
    const container = document.getElementById("view-notifications");
    if (!container) return;
    container.innerHTML = `<div class="loading-state">Loading notification center...</div>`;

    try {
        const [notifRes, recRes] = await Promise.all([
            apiFetch("/api/admin/notifications"),
            apiFetch("/api/admin/notifications/recipients").catch(() => ({ data: { routes: [], buses: [] } }))
        ]);

        state.notifications = notifRes.notifications || [];
        // ROOT CAUSE FIX: backend returns {success, routes, buses} at top level — NOT under .data
        state.recipients = {
            routes: recRes.routes || [],
            buses: recRes.buses || []
        };

        renderNotificationsView();
    } catch (err) {
        container.innerHTML = `<div class="error-box">Could not load notification center: ${esc(err.message)}</div>`;
    }
}

function renderNotificationsView() {
    const container = document.getElementById("view-notifications");
    if (!container) return;

    const routes = state.recipients.routes || [];
    const buses = state.recipients.buses || [];
    const rows = state.notifications || [];

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Notification &amp; Announcement Center</h1>
                <p class="subtitle">Broadcast official announcements to students, drivers, specific routes, or publish live alerts on the public homepage.</p>
            </div>
        </div>

        <div class="notif-composer-card">
            <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 18px; color: #0f172a;">📢 Compose New Announcement</h3>

            <form id="adminNotifForm">
                <div class="composer-grid">
                    <div class="field">
                        <label for="notifAudience" style="font-weight: 700; color: #0f172a; margin-bottom: 6px; display: block;">Target Audience <span style="color: #e11d48;">*</span></label>
                        <select id="notifAudience" name="audience" required onchange="handleAudienceChange(this.value)" style="width: 100%; padding: 10px 12px; border: 1.5px solid #cbd5e1; border-radius: 9px; font-weight: 600;">
                            <option value="all">Entire College (All Students &amp; Drivers)</option>
                            <option value="students">All Registered Students</option>
                            <option value="drivers">All Fleet Drivers</option>
                            <option value="route">Specific Bus Route</option>
                            <option value="bus">Specific Assigned Bus</option>
                            <option value="public">Public Homepage Announcement (Website Visitors)</option>
                        </select>
                    </div>

                    <div class="field" id="wrapRouteSelect" style="display: none;">
                        <label for="notifRouteId" style="font-weight: 700; color: #0f172a; margin-bottom: 6px; display: block;">Select Route <span style="color: #e11d48;">*</span></label>
                        <select id="notifRouteId" name="route_id" style="width: 100%; padding: 10px 12px; border: 1.5px solid #cbd5e1; border-radius: 9px;">
                            ${routes.map(rt => `<option value="${rt.route_id}">${esc(rt.route_name)} (${rt.student_count || 0} students)</option>`).join("")}
                        </select>
                    </div>

                    <div class="field" id="wrapBusSelect" style="display: none;">
                        <label for="notifBusId" style="font-weight: 700; color: #0f172a; margin-bottom: 6px; display: block;">Select Bus <span style="color: #e11d48;">*</span></label>
                        <select id="notifBusId" name="bus_id" style="width: 100%; padding: 10px 12px; border: 1.5px solid #cbd5e1; border-radius: 9px;">
                            ${buses.map(b => `<option value="${b.bus_id}">${esc(b.bus_number)} — ${esc(b.route_name || 'No Route')} (${b.student_count || 0} students)</option>`).join("")}
                        </select>
                    </div>

                    <div class="field">
                        <label for="notifType" style="font-weight: 700; color: #0f172a; margin-bottom: 6px; display: block;">Notification Category</label>
                        <select id="notifType" name="type" style="width: 100%; padding: 10px 12px; border: 1.5px solid #cbd5e1; border-radius: 9px;">
                            <option value="GENERAL">General Notice</option>
                            <option value="BUS_UPDATE">Transit &amp; Route Schedule Update</option>
                            <option value="EMERGENCY">Emergency / Weather Alert</option>
                            <option value="FEE_REMINDER">Transportation Fee Reminder</option>
                            <option value="MAINTENANCE">Fleet Maintenance Notice</option>
                        </select>
                    </div>
                </div>

                <div class="field full" style="margin-bottom: 16px;">
                    <label for="notifTitle" style="font-weight: 700; color: #0f172a; margin-bottom: 6px; display: block;">Announcement Title <span style="color: #e11d48;">*</span></label>
                    <input type="text" id="notifTitle" name="title" required placeholder="e.g. Bus Schedule Delay due to Heavy Rain" maxlength="120"
                        style="width: 100%; padding: 11px 14px; border: 1.5px solid #cbd5e1; border-radius: 9px; font-weight: 600;">
                </div>

                <div class="field full" style="margin-bottom: 16px;">
                    <div class="voice-toolbar">
                        <label for="notifMessage" style="font-weight: 700; color: #0f172a;">Announcement Content <span style="color: #e11d48;">*</span></label>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <span class="voice-status-text" id="voiceStatusText">Speak or type your message</span>
                            <button type="button" class="btn-voice" id="btnVoiceRecord" onclick="toggleVoiceRecording()">
                                <span>🎤</span> Voice Dictation
                            </button>
                        </div>
                    </div>

                    <textarea id="notifMessage" name="message" rows="4" required maxlength="500"
                        placeholder="Type message here or click 'Voice Dictation' to convert speech to editable text..."
                        oninput="updateNotifCharCount(this)"
                        style="width: 100%; padding: 12px 14px; border: 1.5px solid #cbd5e1; border-radius: 9px; font-size: 13.5px; resize: vertical; line-height: 1.5;"></textarea>

                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 12px; color: #64748b;">
                        <span>💡 You can freely review, edit, or append to converted voice text before sending.</span>
                        <span id="notifCharCount">0 / 500</span>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 8px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 600; color: #334155;">
                        <input type="checkbox" id="notifPublicCheckbox" name="is_public" value="1" style="width: 17px; height: 17px; accent-color: var(--primary);">
                        Also display on Public Homepage Transit Notice Board
                    </label>

                    <button type="submit" class="btn btn-primary" id="btnSendNotif" style="padding: 10px 22px; font-size: 14px; font-weight: 700;">
                        📢 Dispatch Announcement
                    </button>
                </div>
            </form>
        </div>

        <div class="table-card">
            <div class="table-toolbar">
                <span class="subtitle" style="font-weight: 700; color: #0f172a;">Recent Announcements &amp; Broadcast History</span>
                <span class="subtitle">${rows.length} recorded</span>
            </div>

            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Date &amp; Time</th>
                            <th>Title &amp; Type</th>
                            <th>Message Preview</th>
                            <th>Audience</th>
                            <th>Sender</th>
                            <th>Public</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(r => `
                            <tr>
                                <td>${formatDateTime(r.created_at)}</td>
                                <td>
                                    <strong>${esc(r.title)}</strong>
                                    <small><span class="badge ${r.type === 'EMERGENCY' ? 'bad' : 'ok'}">${esc(r.type || 'GENERAL')}</span></small>
                                </td>
                                <td>
                                    <div style="max-width: 320px; font-size: 12.5px; color: #334155; line-height: 1.4;">
                                        ${esc(r.message)}
                                    </div>
                                </td>
                                <td>
                                    <span class="badge muted">${esc(r.user_role ? r.user_role.toUpperCase() : 'BROADCAST')}</span>
                                    ${r.bus_id ? `<br><small>Bus #${r.bus_id}</small>` : ''}
                                    ${r.route_id ? `<br><small>Route #${r.route_id}</small>` : ''}
                                </td>
                                <td>
                                    <strong>${esc(r.sender_role ? r.sender_role.toUpperCase() : 'ADMIN')}</strong>
                                </td>
                                <td>
                                    ${r.is_public ? `<span class="badge ok">🌐 Public</span>` : `<span class="badge muted">Internal</span>`}
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="6">No announcements recorded yet.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Bind form submission
    document.getElementById("adminNotifForm")?.addEventListener("submit", submitAdminNotification);
}

function handleAudienceChange(val) {
    const wrapRoute = document.getElementById("wrapRouteSelect");
    const wrapBus = document.getElementById("wrapBusSelect");
    const publicCheckbox = document.getElementById("notifPublicCheckbox");

    if (wrapRoute) wrapRoute.style.display = val === "route" ? "block" : "none";
    if (wrapBus) wrapBus.style.display = val === "bus" ? "block" : "none";
    if (publicCheckbox && val === "public") publicCheckbox.checked = true;

    // Fetch fresh data so newly added routes/buses always appear
    if (val === "route") {
        const sel = document.getElementById("notifRouteId");
        if (sel) {
            sel.innerHTML = `<option value="">Loading routes...</option>`;
            apiFetch("/api/admin/notifications/recipients")
                .then(res => {
                    const routes = res.routes || [];
                    state.recipients.routes = routes;
                    sel.innerHTML = routes.length
                        ? routes.map(rt => `<option value="${rt.route_id}">${esc(rt.route_name)} (${rt.student_count || 0} students)</option>`).join("")
                        : `<option value="">No routes available</option>`;
                })
                .catch(() => { sel.innerHTML = `<option value="">Failed to load routes</option>`; });
        }
    } else if (val === "bus") {
        const sel = document.getElementById("notifBusId");
        if (sel) {
            sel.innerHTML = `<option value="">Loading buses...</option>`;
            apiFetch("/api/admin/notifications/recipients")
                .then(res => {
                    const buses = res.buses || [];
                    state.recipients.buses = buses;
                    sel.innerHTML = buses.length
                        ? buses.map(b => `<option value="${b.bus_id}">${esc(b.bus_number)} — ${esc(b.route_name || 'No Route')} (${b.student_count || 0} students)</option>`).join("")
                        : `<option value="">No buses available</option>`;
                })
                .catch(() => { sel.innerHTML = `<option value="">Failed to load buses</option>`; });
        }
    }
}

function updateNotifCharCount(el) {
    const counter = document.getElementById("notifCharCount");
    if (counter) counter.textContent = `${el.value.length} / 500`;
}

function toggleVoiceRecording() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = document.getElementById("btnVoiceRecord");
    const statusEl = document.getElementById("voiceStatusText");
    const textarea = document.getElementById("notifMessage");

    if (!SpeechRecognition) {
        showToast("Speech recognition is not supported in this browser. Please use Google Chrome or Microsoft Edge.", "warn");
        if (statusEl) statusEl.textContent = "Voice dictation not supported in browser. Please type.";
        return;
    }

    if (isRecordingVoice && speechRecognitionInstance) {
        try {
            speechRecognitionInstance.stop();
        } catch (e) {
            console.warn("Speech stop:", e);
        }
        isRecordingVoice = false;
        if (btn) {
            btn.classList.remove("recording-active");
            btn.innerHTML = `<span>🎤</span> Voice Dictation`;
        }
        if (statusEl) statusEl.textContent = "Dictation stopped. You can edit text below.";
        return;
    }

    try {
        speechRecognitionInstance = new SpeechRecognition();
        speechRecognitionInstance.continuous = true;
        speechRecognitionInstance.interimResults = true;
        speechRecognitionInstance.lang = "en-IN";
        speechRecognitionInstance.maxAlternatives = 1;

        const currentVal = textarea ? textarea.value : "";
        voiceBaseText = currentVal.trim() ? (currentVal.trim() + " ") : "";
        sessionFinalTranscript = "";

        speechRecognitionInstance.onstart = () => {
            isRecordingVoice = true;
            if (btn) {
                btn.classList.add("recording-active");
                btn.innerHTML = `<span>🛑</span> Stop Dictating`;
            }
            if (statusEl) statusEl.textContent = "Listening... Speak clearly into your microphone.";
            showToast("Microphone is active. Speak clearly...", "info");
        };

        speechRecognitionInstance.onresult = (event) => {
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const item = event.results[i];
                if (item.isFinal) {
                    sessionFinalTranscript += (sessionFinalTranscript ? " " : "") + item[0].transcript.trim();
                } else {
                    interim += item[0].transcript;
                }
            }
            if (textarea) {
                const spoken = (sessionFinalTranscript + (interim ? " " + interim.trim() : "")).trim();
                textarea.value = (voiceBaseText + spoken).slice(0, 500);
                updateNotifCharCount(textarea);
            }
        };

        speechRecognitionInstance.onerror = (event) => {
            console.warn("Speech recognition error:", event.error);
            let userMsg = "Dictation stopped.";
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                userMsg = "Microphone access blocked. Please allow mic permission in your browser.";
                showToast(userMsg, "error");
            } else if (event.error === "no-speech") {
                userMsg = "No speech detected. Speak closer to the microphone.";
            } else if (event.error === "network") {
                userMsg = "Network error during speech recognition.";
                showToast(userMsg, "warn");
            }
            if (statusEl) statusEl.textContent = userMsg;
        };

        speechRecognitionInstance.onend = () => {
            isRecordingVoice = false;
            if (btn) {
                btn.classList.remove("recording-active");
                btn.innerHTML = `<span>🎤</span> Voice Dictation`;
            }
            if (statusEl) {
                statusEl.textContent = "Speech converted. Review and edit text before sending.";
            }
        };

        speechRecognitionInstance.start();
    } catch (err) {
        console.error("Speech recognition start failed:", err);
        isRecordingVoice = false;
        if (btn) {
            btn.classList.remove("recording-active");
            btn.innerHTML = `<span>🎤</span> Voice Dictation`;
        }
        showToast("Could not start voice dictation: " + err.message, "error");
    }
}

async function submitAdminNotification(e) {
    e.preventDefault();
    const btn = document.getElementById("btnSendNotif");
    const audience = document.getElementById("notifAudience").value;
    const title = document.getElementById("notifTitle").value.trim();
    const message = document.getElementById("notifMessage").value.trim();
    const type = document.getElementById("notifType").value;
    const isPublic = document.getElementById("notifPublicCheckbox").checked ? 1 : 0;
    const routeId = document.getElementById("notifRouteId")?.value;
    const busId = document.getElementById("notifBusId")?.value;

    if (!title || !message) {
        showToast("Please provide both title and announcement message.", "error");
        return;
    }

    try {
        if (btn) btn.disabled = true;
        const payload = {
            title,
            message,
            type,
            audience,
            is_public: isPublic || (audience === "public" ? 1 : 0),
            route_id: audience === "route" ? Number(routeId) : null,
            bus_id: audience === "bus" ? Number(busId) : null
        };

        const res = await apiFetch("/api/admin/notifications", {
            method: "POST",
            body: JSON.stringify(payload)
        });

        showToast(res.message || "Announcement dispatched successfully!", "success");
        await loadAdminNotifications();
    } catch (err) {
        showToast("Failed to dispatch announcement: " + err.message, "error");
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* =========================================================
   16. INBOX / CONTACT MESSAGES SECTION
========================================================= */

async function loadContactMessages() {
    try {
        const res = await apiFetch("/api/admin/contact-messages");
        state.contactMessages = res.messages || [];
        renderMessagesView();
    } catch (err) {
        console.error("Load contact messages error:", err);
        showToast("Failed to load contact messages: " + err.message, "error");
    }
}

function renderMessagesView() {
    const container = document.getElementById("view-messages");
    if (!container) return;

    const query = state.searchQuery.toLowerCase();
    const rows = state.contactMessages.filter(m => {
        if (!query) return true;
        return (
            (m.name && m.name.toLowerCase().includes(query)) ||
            (m.email && m.email.toLowerCase().includes(query)) ||
            (m.message && m.message.toLowerCase().includes(query))
        );
    });

    const totalCount = state.contactMessages.length;
    const unreadCount = state.contactMessages.filter(m => !m.is_read).length;

    container.innerHTML = `
        <div class="welcome-row">
            <div>
                <h1>Inbox &amp; Contact Messages</h1>
                <p class="subtitle">Direct messages and general inquiries submitted by visitors and students through the CampusGo homepage.</p>
            </div>
            <div class="welcome-actions">
                <button type="button" class="btn btn-secondary" onclick="loadContactMessages()">⟳ Refresh Messages</button>
            </div>
        </div>

        <div class="summary-strip">
            <div class="summary-item"><strong>${totalCount}</strong><span>Total Inquiries</span></div>
            <div class="summary-item"><strong style="color: #dc2626;">${unreadCount}</strong><span>Unread Messages</span></div>
            <div class="summary-item"><strong>${totalCount - unreadCount}</strong><span>Read Messages</span></div>
        </div>

        <div class="table-card">
            <div class="table-toolbar">
                <h3>Website Contact Messages</h3>
                <span class="subtitle">${rows.length} message${rows.length === 1 ? '' : 's'} displayed</span>
            </div>

            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Sender Name</th>
                            <th>Contact Info</th>
                            <th>Message Content</th>
                            <th>Received At</th>
                            <th>Status</th>
                            <th class="actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.length ? rows.map(m => `
                            <tr style="${!m.is_read ? 'background: #f8faff; font-weight: 500;' : ''}">
                                <td>
                                    <strong>${esc(m.name)}</strong>
                                    ${!m.is_read ? `<span class="badge badge-warning" style="font-size:10px; margin-left:4px;">New</span>` : ''}
                                </td>
                                <td>
                                    <code>${esc(m.email)}</code>
                                </td>
                                <td>
                                    <div style="max-width: 320px; font-size: 12.5px; color: #334155; line-height: 1.4; white-space: normal;" title="${esc(m.message)}">
                                        ${esc(m.message)}
                                    </div>
                                </td>
                                <td>${formatDateTime(m.created_at)}</td>
                                <td>
                                    ${m.is_read ? `<span class="badge ok">Read</span>` : `<span class="badge bad">Unread</span>`}
                                </td>
                                <td>
                                    <div class="actions">
                                        <button class="btn-icon btn-icon-view" title="View Details" onclick="viewContactMessageDetails(${m.id})">👁️</button>
                                        ${!m.is_read ? `<button class="btn-icon btn-icon-success" title="Mark as Read" onclick="markContactMessageRead(${m.id})">✓</button>` : ''}
                                        <button class="btn-icon btn-icon-delete" title="Delete Message" onclick="deleteContactMessage(${m.id}, '${esc(m.name)}')">🗑️</button>
                                    </div>
                                </td>
                            </tr>
                        `).join("") : `<tr class="empty-row"><td colspan="6">No contact messages received yet.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function viewContactMessageDetails(id) {
    const m = state.contactMessages.find(x => x.id === id);
    if (!m) return;
    openDetailsModal(`Contact Message from ${m.name}`, [
        { label: "Message ID", value: `#MSG-${m.id}` },
        { label: "Sender Name", value: m.name },
        { label: "Email / Phone", value: m.email },
        { label: "Received Date", value: formatDateTime(m.created_at) },
        { label: "Read Status", value: m.is_read ? "Read" : "Unread" },
        { label: "Message Content", value: esc(m.message) }
    ], `
        <div style="display:flex; gap:8px;">
            ${!m.is_read ? `<button type="button" class="btn btn-primary" onclick="markContactMessageRead(${m.id})">Mark as Read</button>` : ''}
            <button type="button" class="btn btn-danger" onclick="deleteContactMessage(${m.id}, '${esc(m.name)}')">Delete Message</button>
        </div>
    `);
}

async function markContactMessageRead(id) {
    try {
        const res = await apiFetch(`/api/admin/contact-messages/${id}/read`, { method: "PATCH" });
        showToast(res.message || "Message marked as read.", "success");
        const item = state.contactMessages.find(x => x.id === id);
        if (item) item.is_read = 1;
        renderMessagesView();
        loadStats();
        closeDetailsModal();
    } catch (err) {
        showToast("Failed to mark message as read: " + err.message, "error");
    }
}

async function deleteContactMessage(id, name) {
    if (!confirm(`Are you sure you want to delete message from ${name || 'visitor'}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/contact-messages/${id}`, { method: "DELETE" });
        showToast(res.message || "Message deleted successfully.", "success");
        state.contactMessages = state.contactMessages.filter(x => x.id !== id);
        renderMessagesView();
        loadStats();
        closeDetailsModal();
    } catch (err) {
        showToast("Failed to delete message: " + err.message, "error");
    }
}

/* =========================================================
   NAVIGATION & VIEW ROUTING
========================================================= */

const VALID_VIEWS = [
    "dashboard",
    "requests",
    "students",
    "drivers",
    "buses",
    "routes",
    "fee-assignments",
    "payments",
    "pass-requests",
    "bus-passes",
    "cancellations",
    "tracking",
    "reports",
    "diesel",
    "notifications",
    "messages"
];

function setFilter(key, val) {
    state.filters[key] = val;
    if (key === "requests") renderDriverRequestsView();
    else if (key === "studentsFee" || key === "studentsRoute" || key === "studentsBus") {
        if (state.currentView === "students") renderStudentsView();
        if (state.currentView === "fee-assignments") renderFeeAssignmentsView();
    }
    else if (key === "driversStatus") renderDriversView();
    else if (key === "busesCondition") renderBusesView();
    else if (key === "paymentsStatus") renderPaymentsView();
    else if (key === "passRequestsStatus") renderPassRequestsView();
    else if (key === "cancellationsStatus") renderCancellationsView();
    else if (key === "dieselBus") renderDieselView();
}

function navigateToSection(viewName, filterKey = null, filterVal = null) {
    if (filterKey && filterVal !== null) {
        state.filters[filterKey] = filterVal;
    }
    location.hash = "#" + viewName;
}

function showView() {
    let hash = location.hash.replace("#", "").trim();
    if (!VALID_VIEWS.includes(hash)) {
        hash = "dashboard";
    }

    state.currentView = hash;

    // Toggle active view container
    document.querySelectorAll(".view").forEach(el => {
        el.classList.toggle("active", el.id === `view-${hash}`);
    });

    // Toggle active link in sidebar and mobile tabs
    document.querySelectorAll("#mainNav a, #mobileTabs a").forEach(link => {
        const linkHash = link.getAttribute("href")?.replace("#", "");
        link.classList.toggle("active", linkHash === hash);
    });

    // Update breadcrumb
    const activeLink = document.querySelector(`#mainNav a[href="#${hash}"]`);
    const crumb = document.getElementById("crumb");
    if (crumb) {
        crumb.textContent = activeLink ? activeLink.textContent.trim().replace(/^[^\w]+/, '') : "Dashboard";
    }

    // Reset search on tab switch
    const searchInput = document.getElementById("dashboardSearch");
    if (searchInput) searchInput.value = "";
    state.searchQuery = "";

    // Trigger loader for active view
    switch (hash) {
        case "dashboard":
            loadStats();
            break;
        case "requests":
            loadDriverRequests();
            break;
        case "students":
            loadStudents();
            break;
        case "drivers":
            loadDrivers();
            break;
        case "buses":
            loadBuses();
            break;
        case "routes":
            loadRoutes();
            break;
        case "fee-assignments":
            loadFeeAssignments();
            break;
        case "payments":
            loadPayments();
            break;
        case "pass-requests":
            loadPassRequests();
            break;
        case "bus-passes":
            loadBusPasses();
            break;
        case "cancellations":
            loadCancellations();
            break;
        case "tracking":
            loadLiveTracking();
            break;
        case "reports":
            loadReports();
            break;
        case "diesel":
            loadDieselRecords();
            break;
        case "notifications":
            loadAdminNotifications();
            break;
        case "messages":
            loadContactMessages();
            break;
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
}

window.addEventListener("hashchange", showView);

/* =========================================================
   SEARCH FILTERING
========================================================= */

const searchInput = document.getElementById("dashboardSearch");
searchInput?.addEventListener("input", function () {
    state.searchQuery = this.value.trim();
    const v = state.currentView;
    if (v === "requests") renderDriverRequestsView();
    else if (v === "students") renderStudentsView();
    else if (v === "drivers") renderDriversView();
    else if (v === "buses") renderBusesView();
    else if (v === "routes") renderRoutesView();
    else if (v === "fee-assignments") renderFeeAssignmentsView();
    else if (v === "payments") renderPaymentsView();
    else if (v === "pass-requests") renderPassRequestsView();
    else if (v === "bus-passes") renderBusPassesView();
    else if (v === "cancellations") renderCancellationsView();
    else if (v === "diesel") renderDieselView();
    else if (v === "notifications") renderNotificationsView();
    else if (v === "messages") renderMessagesView();
});

/* =========================================================
   SOCKET.IO LIVE SYNCHRONIZATION
========================================================= */

function initSocket() {
    if (typeof io !== "function") return;

    socket = io(API_BASE, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    socket.on("connect", () => {
        isSocketConnected = true;
        loadStats();
    });

    socket.on("disconnect", () => {
        isSocketConnected = false;
    });

    socket.on("statsUpdated", data => {
        if (!data || data.success === false) return;
        applyStatsToUI(data);
    });

    socket.on("driverRequestsUpdated", () => {
        if (state.currentView === "requests") loadDriverRequests();
        loadStats();
    });

    socket.on("studentsUpdated", () => {
        if (state.currentView === "students") loadStudents();
        loadStats();
    });

    socket.on("driversUpdated", () => {
        if (state.currentView === "drivers") loadDrivers();
        if (state.currentView === "buses") loadBuses();
        loadStats();
    });

    socket.on("busesUpdated", () => {
        if (state.currentView === "buses") loadBuses();
        if (state.currentView === "drivers") loadDrivers();
        loadStats();
    });

    socket.on("routesUpdated", () => {
        if (state.currentView === "routes") loadRoutes();
    });

    socket.on("feesUpdated", () => {
        if (state.currentView === "fee-assignments") loadFeeAssignments();
        if (state.currentView === "students") loadStudents();
    });

    socket.on("paymentsUpdated", () => {
        if (state.currentView === "payments") loadPayments();
        if (state.currentView === "fee-assignments") loadFeeAssignments();
        loadStats();
    });

    socket.on("busPassesUpdated", () => {
        if (state.currentView === "pass-requests") loadPassRequests();
        if (state.currentView === "bus-passes") loadBusPasses();
        loadStats();
    });

    socket.on("cancellationRequested", () => {
        if (state.currentView === "cancellations") loadCancellations();
        loadStats();
        showToast("New student cancellation request received.", "info");
    });

    socket.on("cancellationUpdated", () => {
        if (state.currentView === "cancellations") loadCancellations();
        if (state.currentView === "students") loadStudents();
        if (state.currentView === "bus-passes") loadBusPasses();
        loadStats();
    });

    socket.on("dieselRecorded", () => {
        if (state.currentView === "diesel") loadDieselRecords();
        showToast("New fleet diesel refuel recorded.", "info");
    });

    socket.on("newNotification", data => {
        if (state.currentView === "notifications") loadAdminNotifications();
        if (data && data.sender_role === "driver") {
            showToast(`Driver Notice (${data.bus_number || 'Transit'}): ${data.title}`, "info");
        }
    });

    socket.on("newContactMessage", msg => {
        showToast(`✉️ New contact message from ${msg?.name || 'Visitor'}!`, "info");
        if (state.currentView === "messages") loadContactMessages();
        loadStats();
    });

    socket.on("busLocationUpdated", data => {
        if (state.currentView === "tracking") {
            const bus = state.liveBuses.find(b => b.bus_id === data.bus_id);
            if (bus) {
                bus.latitude = data.latitude;
                bus.longitude = data.longitude;
                bus.speed = data.speed;
                bus.heading = data.heading;
                bus.recorded_at = data.recorded_at;
                bus.is_live = true;
                initOrUpdateMap();
            }
        }
    });
}

/* =========================================================
   LOGOUT & INIT
========================================================= */

document.getElementById("logoutBtn")?.addEventListener("click", () => {
    if (confirm("Are you sure you want to log out of the Admin Dashboard?")) {
        localStorage.removeItem("campusgoUser");
        localStorage.removeItem("campusgoRole");
        localStorage.removeItem("campusgoToken");
        window.location.href = "login.html";
    }
});

// Initialize on DOM load
window.addEventListener("DOMContentLoaded", () => {
    checkAuth();
    initSocket();
    showView();

    // Auto-refresh fallback every 20 seconds
    setInterval(() => {
        loadStats();
    }, 20000);
});
