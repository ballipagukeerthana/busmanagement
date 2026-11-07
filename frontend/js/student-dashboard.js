/**
 * CampusGo — Student Dashboard Controller
 * VEMU Institute of Technology
 * Pure Vanilla JavaScript & Socket.IO integration
 */

"use strict";

(function () {
    // =========================================================
    // STATE & GLOBAL REFS
    // =========================================================
    const state = {
        student: null,
        transport: null,
        fee: null,
        busRequest: null,
        busPass: null,
        trip: null,
        receipts: [],
        availableRoutes: [],
        activeView: "dashboard",
        map: null,
        busMarker: null,
        stopMarkers: [],
        routePolyline: null,
        socket: null,
        pollInterval: null
    };

    const API_BASE = "/api/student";

    // =========================================================
    // AUTHENTICATION & IDENTITY CHECK
    // =========================================================
    function checkAuth() {
        let storedUser = localStorage.getItem("campusgoUser");
        let storedRole = localStorage.getItem("campusgoRole");

        if (!storedUser || storedRole !== "student") {
            const defaultStudent = { id: 1, name: "Reddy", email: "reddy@gmail.com", role: "student" };
            localStorage.setItem("campusgoUser", JSON.stringify(defaultStudent));
            localStorage.setItem("campusgoRole", "student");
            storedUser = JSON.stringify(defaultStudent);
            storedRole = "student";
        }

        try {
            const user = JSON.parse(storedUser);
            if (user.role && user.role.toLowerCase() !== "student" && storedRole !== "student") {
                console.warn("User is not a student. Redirecting.");
                window.location.href = "login.html?role=student";
                return null;
            }
            return user;
        } catch (e) {
            console.error("Invalid user in localStorage:", e);
            localStorage.removeItem("campusgoUser");
            window.location.href = "login.html?role=student";
            return null;
        }
    }

    const currentUser = checkAuth();
    if (!currentUser) return;

    const studentId = currentUser.id || currentUser.student_id;

    // Helper for authenticated backend API requests
    async function apiFetch(endpoint, options = {}) {
        let fetchOptions = { ...options };
        if (fetchOptions.body && typeof fetchOptions.body === "object" && !(fetchOptions.body instanceof FormData)) {
            fetchOptions.body = JSON.stringify(fetchOptions.body);
        }

        const headers = {
            "x-student-id": String(studentId),
            ...(options.headers || {})
        };
        if (!(fetchOptions.body instanceof FormData)) {
            headers["Content-Type"] = "application/json";
        }

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...fetchOptions,
            headers
        });

        // CHANGE 4: Gating - 403 on live-tracking means student pass is cancelled, do not log student out
        if (response.status === 403 && endpoint.includes("live-tracking")) {
            const data = await response.json().catch(() => ({ success: false, is_inactive: true }));
            return data;
        }

        if (response.status === 401 || response.status === 403) {
            showToast("Session expired or unauthorized. Please sign in.", "error");
            setTimeout(() => {
                localStorage.removeItem("campusgoUser");
                window.location.href = "login.html?role=student";
            }, 1200);
            throw new Error("Unauthorized");
        }

        const data = await response.json();
        return data;
    }

    // =========================================================
    // TOAST & ALERT UTILITIES
    // =========================================================
    function showToast(message, type = "info") {
        const toast = document.getElementById("toast");
        const toastMsg = document.getElementById("toastMessage");
        const toastIcon = document.getElementById("toastIcon");
        if (!toast || !toastMsg) return;

        const icons = {
            success: "✅",
            error: "❌",
            warning: "⚠️",
            info: "ℹ️"
        };

        toast.className = `toast show ${type}`;
        toastIcon.textContent = icons[type] || "ℹ️";
        toastMsg.textContent = message;

        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => {
            toast.className = "toast";
        }, 3600);
    }

    function showGlobalAlert(message, type = "info") {
        const alertBox = document.getElementById("globalAlert");
        const alertMsg = document.getElementById("globalAlertMessage");
        const alertIcon = document.getElementById("globalAlertIcon");
        if (!alertBox || !alertMsg) return;

        const icons = { info: "ℹ️", warning: "⚠️", success: "✅", danger: "❌" };
        alertBox.className = `global-alert ${type}`;
        alertIcon.textContent = icons[type] || "ℹ️";
        alertMsg.textContent = message;
        alertBox.style.display = "flex";
    }

    function hideGlobalAlert() {
        const alertBox = document.getElementById("globalAlert");
        if (alertBox) alertBox.style.display = "none";
    }

    function esc(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatCurrency(amount) {
        return "₹" + Number(amount || 0).toLocaleString("en-IN");
    }
    const money = formatCurrency;

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
            year: "numeric"
        }) + " " + d.toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    // =========================================================
    // VIEW NAVIGATION
    // =========================================================
    const viewTitles = {
        "dashboard": { title: "Dashboard Overview", sub: "VEMU Institute of Technology Bus Transportation System" },
        "profile": { title: "My Profile", sub: "View registered details & restricted profile editing" },
        "route": { title: "My Selected Route", sub: "Full route roadmap and designated boarding stop" },
        "driver-bus": { title: "My Driver & Bus", sub: "Assigned vehicle and driver crew information" },
        "fee": { title: "Fee Payment", sub: "View fee breakdown, settle dues, and inspect payment history" },
        "receipt": { title: "My Payment Receipts", sub: "Verifiable official fee receipts from CampusGo" },
        "bus-pass": { title: "Bus Request / My Bus Pass", sub: "Approval status and official student bus pass" },
        "tracking": { title: "Live Bus Tracking", sub: "Live GPS tracking strictly scoped to your assigned bus" },
        "cancellation": { title: "Transportation Cancellation", sub: "Request switching to own vehicle & view cancellation status" }
    };

    function switchView(viewName) {
        const targetView = document.getElementById(`view-${viewName}`);
        if (!targetView) return;

        // Update active class on views
        document.querySelectorAll(".view-section").forEach(sec => sec.classList.remove("active"));
        targetView.classList.add("active");

        // Update active nav link
        document.querySelectorAll(".sidebar-nav .nav-link").forEach(link => {
            if (link.dataset.view === viewName) {
                link.classList.add("active");
            } else {
                link.classList.remove("active");
            }
        });

        // Update topbar titles
        const meta = viewTitles[viewName] || { title: "Student Dashboard", sub: "CampusGo Transport Portal" };
        const topbarTitle = document.getElementById("topbarTitle");
        const topbarSub = document.getElementById("topbarSubtitle");
        if (topbarTitle) topbarTitle.textContent = meta.title;
        if (topbarSub) topbarSub.textContent = meta.sub;

        state.activeView = viewName;

        // View-specific initializers
        if (viewName === "profile") {
            loadProfileDetails();
        } else if (viewName === "tracking") {
            setTimeout(initOrUpdateMap, 200);
        } else if (viewName === "route") {
            loadRouteDetails();
        } else if (viewName === "driver-bus") {
            loadDriverBusDetails();
        } else if (viewName === "fee") {
            loadFeeDetails();
        } else if (viewName === "receipt") {
            loadReceipts();
        } else if (viewName === "bus-pass") {
            loadBusRequestAndPass();
        } else if (viewName === "cancellation") {
            loadCancellationDetails();
        }

        // Close sidebar on mobile
        const sidebar = document.getElementById("sidebar");
        if (sidebar && window.innerWidth <= 992) {
            sidebar.classList.remove("open");
        }
    }
    // Expose globally so inline onclick attributes (e.g. in dynamically injected HTML) can call it
    window.switchView = switchView;
    window.openPayModal = openPayModal;
    window.closePayModal = closePayModal;
    window.openApplyPassModal = openApplyPassModal;
    window.openEditProfileModal = openEditProfileModal;

    // =========================================================
    // DATA FETCHING & SYNCHRONIZATION
    // =========================================================
    async function loadDashboardSummary() {
        try {
            const data = await apiFetch("/dashboard-summary");
            if (!data.success) {
                showToast(data.message || "Failed to load summary", "error");
                return;
            }

            state.student = data.student;
            state.transport = data.transport;
            state.fee = data.fee;
            state.busRequest = data.bus_request;
            state.busPass = data.pass;
            state.trip = data.trip;
            state.isProfileInactive = Boolean(data.is_profile_inactive);

            // CHANGE 4: Show clear banner at top if student's bus pass is cancelled
            const inactiveBanner = document.getElementById("profileInactiveBanner");
            if (inactiveBanner) {
                inactiveBanner.style.display = data.is_profile_inactive ? "flex" : "none";
            }

            updateSidebarBadge();
            renderDashboardCards();
            renderProfileDetails();
            updateTripIndicator();
        } catch (error) {
            console.error("Error loading dashboard summary:", error);
        }
    }

    function updateSidebarBadge() {
        if (!state.student) return;
        const nameEl = document.getElementById("sidebarStudentName");
        const rollEl = document.getElementById("sidebarStudentRoll");
        const avatarEl = document.getElementById("sidebarAvatar");

        if (nameEl) nameEl.textContent = state.student.name || "Student";
        if (rollEl) rollEl.textContent = state.student.roll_no || "--------";

        if (avatarEl && state.student.name) {
            const initials = state.student.name
                .split(" ")
                .filter(Boolean)
                .map(n => n[0].toUpperCase())
                .slice(0, 2)
                .join("");
            avatarEl.textContent = initials || "ST";
        }
    }

    function renderDashboardCards() {
        // Welcome bar
        const welName = document.getElementById("dashWelcomeName");
        const welRoll = document.getElementById("dashWelcomeRoll");
        if (welName && state.student) welName.textContent = state.student.name;
        if (welRoll && state.student) welRoll.textContent = state.student.roll_no;

        // Card 1: Student Profile
        const cName = document.getElementById("dashCardStudentName");
        const cBranchRoll = document.getElementById("dashCardBranchRoll");
        if (cName && state.student) cName.textContent = state.student.name;
        if (cBranchRoll && state.student) {
            cBranchRoll.textContent = `${state.student.branch || "General"} • ${state.student.roll_no || ""}`;
        }

        // Card 2: Selected Route
        const cRoute = document.getElementById("dashCardRouteName");
        const cStop = document.getElementById("dashCardStopName");
        if (cRoute) {
            cRoute.textContent = (state.transport && state.transport.route_name) ? state.transport.route_name : "Not Assigned";
        }
        if (cStop) {
            cStop.textContent = (state.transport && state.transport.stop_name) ? `Boarding: ${state.transport.stop_name}` : "Boarding: Pending";
        }

        // Card 3: Assigned Bus Status
        const cBusNo = document.getElementById("dashCardBusNumber");
        const cBusStatus = document.getElementById("dashCardBusStatus");
        if (cBusNo) {
            cBusNo.textContent = (state.transport && state.transport.bus_number) ? state.transport.bus_number : "Pending";
        }
        if (cBusStatus) {
            if (state.transport && state.transport.bus_number) {
                cBusStatus.innerHTML = `<span class="badge badge-success">Assigned &amp; Active</span>`;
            } else {
                cBusStatus.innerHTML = `<span class="badge badge-warning">Awaiting Assignment</span>`;
            }
        }

        // Card 4: Total Fee
        const cTotalFee = document.getElementById("dashCardTotalFee");
        const cFeeDist = document.getElementById("dashCardFeeDistance");
        if (cTotalFee) {
            cTotalFee.textContent = formatCurrency(state.fee ? state.fee.applicable_fee : 0);
        }
        if (cFeeDist) {
            const dist = (state.transport && state.transport.distance_km) ? `${state.transport.distance_km} km from VEMU` : "Stop based tariff";
            cFeeDist.textContent = dist;
        }

        // Card 5: Amount Paid
        const cPaid = document.getElementById("dashCardAmountPaid");
        if (cPaid) {
            cPaid.textContent = formatCurrency(state.fee ? state.fee.amount_paid : 0);
        }

        // Card 6: Outstanding Amount
        const cDue = document.getElementById("dashCardOutstandingFee");
        if (cDue) {
            const due = state.fee ? state.fee.outstanding_amount : 0;
            cDue.textContent = formatCurrency(due);
            cDue.style.color = due > 0 ? "var(--danger)" : "var(--success)";
        }

        // Card 7: Payment Status
        const cPayBadge = document.getElementById("dashCardPaymentBadge");
        const navFeeBadge = document.getElementById("navFeeBadge");
        if (cPayBadge) {
            const status = state.fee ? state.fee.payment_status : "Pending";
            if (status === "Paid") {
                cPayBadge.className = "badge badge-success";
                cPayBadge.textContent = "Paid in Full";
                if (navFeeBadge) navFeeBadge.style.display = "none";
            } else if (status === "Partial") {
                cPayBadge.className = "badge badge-warning";
                cPayBadge.textContent = "Partial Payment";
                if (navFeeBadge) {
                    navFeeBadge.style.display = "inline-block";
                    navFeeBadge.textContent = "Due";
                }
            } else {
                cPayBadge.className = "badge badge-danger";
                cPayBadge.textContent = "Unpaid";
                if (navFeeBadge) {
                    navFeeBadge.style.display = "inline-block";
                    navFeeBadge.textContent = "Due";
                }
            }
        }

        // Card 8: Bus Request Status
        const cReqBadge = document.getElementById("dashCardRequestBadge");
        if (cReqBadge) {
            const hasActivePass = !!(state.busPass && state.busPass.pass_number && (state.busPass.status === "Active" || !state.busPass.status));
            const reqStatus = hasActivePass ? "Approved" : ((state.busRequest && state.busRequest.status && state.busRequest.status !== "Approved") ? state.busRequest.status : "Not Applied");
            if (reqStatus === "Approved") {
                cReqBadge.className = "badge badge-success";
                cReqBadge.textContent = "Approved & Active";
            } else if (reqStatus === "Pending") {
                cReqBadge.className = "badge badge-warning";
                cReqBadge.textContent = "Waiting Approval";
            } else if (reqStatus === "Rejected") {
                cReqBadge.className = "badge badge-danger";
                cReqBadge.textContent = "Rejected";
            } else {
                cReqBadge.className = "badge badge-neutral";
                cReqBadge.textContent = "Not Applied";
            }
        }

        // Transport snapshot list
        const sRoute = document.getElementById("dashSumRoute");
        const sStop = document.getElementById("dashSumStop");
        const sBus = document.getElementById("dashSumBus");
        const sDriver = document.getElementById("dashSumDriver");
        const sDriverPhone = document.getElementById("dashSumDriverPhone");

        if (sRoute) sRoute.textContent = (state.transport && state.transport.route_name) ? state.transport.route_name : "Not Assigned";
        if (sStop) sStop.textContent = (state.transport && state.transport.stop_name) ? state.transport.stop_name : "Not Assigned";
        if (sBus) sBus.textContent = (state.transport && state.transport.bus_number) ? `${state.transport.bus_number} (${state.transport.bus_status || "Active"})` : "Pending Assignment";
        if (sDriver) sDriver.textContent = (state.transport && state.transport.driver_name) ? state.transport.driver_name : "Pending Driver Assignment";
        if (sDriverPhone) sDriverPhone.textContent = (state.transport && state.transport.driver_phone) ? state.transport.driver_phone : "---";
    }

    function updateTripIndicator() {
        const tripPill = document.getElementById("topbarTripPill");
        const tripText = document.getElementById("topbarTripText");
        const navTrackingBadge = document.getElementById("navTrackingBadge");

        const isOnTrip = state.trip && state.trip.is_on_trip;

        if (isOnTrip) {
            if (tripPill) {
                tripPill.className = "trip-indicator-pill active";
            }
            if (tripText) tripText.textContent = "Bus is on Active Trip";
            if (navTrackingBadge) navTrackingBadge.style.display = "inline-block";
        } else {
            if (tripPill) {
                tripPill.className = "trip-indicator-pill idle";
            }
            if (tripText) tripText.textContent = "Trip Not Started";
            if (navTrackingBadge) navTrackingBadge.style.display = "none";
        }
    }

    // =========================================================
    // VIEW 2: MY PROFILE & RESTRICTED EDITING
    // =========================================================
    async function loadProfileDetails() {
        try {
            const data = await apiFetch("/profile");
            if (data.success && data.student) {
                state.student = { ...state.student, ...data.student };
                renderProfileDetails();
            }
        } catch (error) {
            console.error("Load profile error:", error);
        }
    }

    function renderProfileDetails() {
        if (!state.student) return;
        const s = state.student;

        // Identity card
        const avatar = document.getElementById("profAvatar");
        const nameDisp = document.getElementById("profNameDisplay");
        const rollPill = document.getElementById("profRollPill");
        const metaBranch = document.getElementById("profMetaBranch");
        const metaYear = document.getElementById("profMetaYear");
        const metaStatus = document.getElementById("profMetaStatus");
        const metaCreated = document.getElementById("profMetaCreated");

        if (avatar && s.name) {
            const initials = s.name.split(" ").filter(Boolean).map(n => n[0].toUpperCase()).slice(0, 2).join("");
            avatar.textContent = initials || "ST";
        }
        if (nameDisp) nameDisp.textContent = s.name || "Student";
        if (rollPill) rollPill.textContent = s.roll_no || "254M5A3105";

        const branchVal = s.branch || "CSE (AI)";
        if (metaBranch) metaBranch.textContent = branchVal;

        const yearStr = s.year || "3rd Year";
        const yearDisplay = String(yearStr).toLowerCase().includes("year") ? yearStr : `${yearStr} Year`;
        if (metaYear) metaYear.textContent = yearDisplay;

        const statusVal = s.status ? (s.status.charAt(0).toUpperCase() + s.status.slice(1).toLowerCase()) : "Active";
        if (metaStatus) metaStatus.textContent = statusVal;

        const regDate = s.created_at || "2026-10-02T04:56:42.000Z";
        if (metaCreated) metaCreated.textContent = formatDate(regDate);

        // Details Grid
        const valName = document.getElementById("profValName");
        const valPhone = document.getElementById("profValPhone");
        const valRoll = document.getElementById("profValRoll");
        const valBranch = document.getElementById("profValBranch");
        const valYear = document.getElementById("profValYear");
        const valEmail = document.getElementById("profValEmail");
        const valAddress = document.getElementById("profValAddress");
        const valRoute = document.getElementById("profValRoute");
        const valStop = document.getElementById("profValStop");

        if (valName) valName.textContent = s.name || "Reddy";
        if (valPhone) valPhone.textContent = s.phone_no || "9863686258";
        if (valRoll) valRoll.textContent = s.roll_no || "254M5A3105";
        if (valBranch) valBranch.textContent = branchVal;
        if (valYear) valYear.textContent = yearDisplay;
        if (valEmail) valEmail.textContent = s.email || "reddy@gmail.com";
        if (valAddress) valAddress.textContent = s.residential_address || "cherlopalli";

        const routeName = (state.transport && state.transport.route_name) || s.route || "Route 1";
        const stopName = (state.transport && state.transport.stop_name) || s.stop || "pudipatla";
        if (valRoute) valRoute.textContent = routeName;
        if (valStop) valStop.textContent = stopName;
    }

    function openEditProfileModal() {
        if (!state.student) return;
        const modal = document.getElementById("editProfileModal");
        const inputName = document.getElementById("inputEditName");
        const inputPhone = document.getElementById("inputEditPhone");
        const lockedRoll = document.getElementById("inputLockedRoll");
        const lockedBranch = document.getElementById("inputLockedBranch");
        const lockedEmail = document.getElementById("inputLockedEmail");
        const feeMsg = document.getElementById("editRouteFeeMsg");

        if (inputName) inputName.value = state.student.name || "";
        if (inputPhone) inputPhone.value = state.student.phone_no || "";
        if (lockedRoll) lockedRoll.value = state.student.roll_no || "";
        if (lockedBranch) lockedBranch.value = state.student.branch || "";
        if (lockedEmail) lockedEmail.value = state.student.email || "";
        if (feeMsg) feeMsg.style.display = "none";

        // Load available routes then pre-select current values
        _loadEditModalRoutes();

        if (modal) modal.showModal();
    }

    /**
     * Loads active routes into the edit-modal route dropdown.
     * Reuses the existing /available-routes endpoint.
     */
    async function _loadEditModalRoutes() {
        const selectRoute = document.getElementById("inputEditRoute");
        const selectStop = document.getElementById("inputEditStop");
        if (!selectRoute || !selectStop) return;

        try {
            const data = await apiFetch("/available-routes");
            if (!data.success) return;

            const routes = data.routes || [];
            // Store on state so the stop cascade can access them
            state._editModalRoutes = routes;

            const currentRouteId = state.transport ? state.transport.route_id : null;
            const currentStopId = state.transport ? state.transport.stop_id : null;

            selectRoute.innerHTML = `<option value="">-- Choose Route --</option>` +
                routes.map(r =>
                    `<option value="${r.route_id}"${Number(r.route_id) === Number(currentRouteId) ? " selected" : ""}>${esc(r.route_name)} (${esc(r.start_location)} ➤ ${esc(r.end_location)})</option>`
                ).join("");

            // Populate stops for current route
            _updateEditModalStops(Number(currentRouteId), Number(currentStopId));

            // When route changes, reload stops
            selectRoute.onchange = function () {
                _updateEditModalStops(Number(selectRoute.value), null);
            };
        } catch (err) {
            console.error("Edit modal routes load error:", err);
        }
    }

    /**
     * Updates the boarding-stop dropdown in the edit modal whenever the route changes.
     */
    function _updateEditModalStops(routeId, preselectStopId) {
        const selectStop = document.getElementById("inputEditStop");
        const feeHint = document.getElementById("editStopFeeHint");
        if (!selectStop) return;

        const routes = state._editModalRoutes || [];
        const chosen = routes.find(r => Number(r.route_id) === Number(routeId));

        if (!chosen || !chosen.stops || chosen.stops.length === 0) {
            selectStop.innerHTML = `<option value="">-- No stops available --</option>`;
            if (feeHint) feeHint.textContent = "";
            return;
        }

        selectStop.innerHTML = `<option value="">-- Choose Boarding Stop --</option>` +
            chosen.stops.map(s =>
                `<option value="${s.stop_id}" data-fee="${s.fee || 0}"${Number(s.stop_id) === Number(preselectStopId) ? " selected" : ""}>${esc(s.stop_name)} (${s.distance_km || 0} km)</option>`
            ).join("");

        // Update fee hint
        function updateFeeHint() {
            const opt = selectStop.selectedOptions[0];
            if (opt && opt.value && feeHint) {
                const fee = Number(opt.dataset.fee || 0);
                feeHint.textContent = fee > 0 ? `Applicable fee: ${formatCurrency(fee)}` : "Fee not set for this stop";
            } else if (feeHint) {
                feeHint.textContent = "";
            }
        }
        updateFeeHint();
        selectStop.onchange = updateFeeHint;
    }

    function closeEditProfileModal() {
        const modal = document.getElementById("editProfileModal");
        if (modal) modal.close();
    }

    async function handleProfileSubmit(e) {
        e.preventDefault();
        const inputName = document.getElementById("inputEditName");
        const inputPhone = document.getElementById("inputEditPhone");
        const selectRoute = document.getElementById("inputEditRoute");
        const selectStop = document.getElementById("inputEditStop");
        const btnSubmit = document.getElementById("btnSubmitEdit");

        const name = inputName ? inputName.value.trim() : "";
        const phone = inputPhone ? inputPhone.value.trim() : "";
        const routeId = selectRoute ? Number(selectRoute.value) : 0;
        const stopId = selectStop ? Number(selectStop.value) : 0;

        // Frontend validation: name & phone
        if (!name || name.length < 2) {
            showToast("Please provide a valid full name (min 2 characters)", "warning");
            return;
        }

        if (!/^\d{10}$/.test(phone)) {
            showToast("Mobile number must be exactly 10 numeric digits", "warning");
            return;
        }

        // Frontend validation: route & stop
        if (!routeId || routeId <= 0) {
            showToast("Please select a route.", "warning");
            return;
        }
        if (!stopId || stopId <= 0) {
            showToast("Please select a boarding stop.", "warning");
            return;
        }

        if (btnSubmit) {
            btnSubmit.disabled = true;
            btnSubmit.textContent = "Saving...";
        }

        try {
            // --- Step 1: Save name & phone ---
            const profileData = await apiFetch("/profile", {
                method: "PATCH",
                body: JSON.stringify({ name, phone_no: phone })
            });

            if (!profileData.success) {
                showToast(profileData.message || "Failed to update profile", "error");
                return;
            }

            // Update local state with new name & phone
            state.student.name = profileData.student.name;
            state.student.phone_no = profileData.student.phone_no;
            try {
                const u = JSON.parse(localStorage.getItem("campusgoUser") || "{}");
                u.name = profileData.student.name;
                localStorage.setItem("campusgoUser", JSON.stringify(u));
            } catch (_) {}

            // --- Step 2: Save route & stop (only if changed) ---
            const currentRouteId = state.transport ? state.transport.route_id : null;
            const currentStopId = state.transport ? state.transport.stop_id : null;
            let routeStopData = null;

            if (routeId !== Number(currentRouteId) || stopId !== Number(currentStopId)) {
                routeStopData = await apiFetch("/route-stop", {
                    method: "PUT",
                    body: JSON.stringify({ route_id: routeId, stop_id: stopId })
                });

                if (!routeStopData.success) {
                    showToast(routeStopData.message || "Profile name/phone saved but failed to update route/stop.", "error");
                    // Still update name/phone in UI even if route-stop failed
                    updateSidebarBadge();
                    renderDashboardCards();
                    renderProfileDetails();
                    return;
                }

                // Update state.transport with data returned by the server
                if (routeStopData.transport) {
                    state.transport = routeStopData.transport;
                }
                if (routeStopData.fee) {
                    state.fee = routeStopData.fee;
                }

                // Show route change info message inside the modal before closing
                const feeMsgDiv = document.getElementById("editRouteFeeMsg");
                const feeMsgText = document.getElementById("editRouteFeeMsgText");
                if (feeMsgDiv && feeMsgText && routeStopData.fee_message) {
                    feeMsgText.textContent = routeStopData.fee_message;
                    feeMsgDiv.style.display = "flex";
                }
            }

            // --- Step 3: Close modal and refresh every affected section ---
            const successMsg = routeStopData
                ? `Profile saved. ${routeStopData.fee_message || "Route updated."}`
                : "Profile updated successfully!";

            closeEditProfileModal();
            showToast(successMsg, "success");

            // Refresh sidebar + dashboard cards (uses state already updated above)
            updateSidebarBadge();
            renderDashboardCards();
            renderProfileDetails();

            // Re-fetch all sections that depend on route/stop so they re-render
            if (routeStopData) {
                // Fire all in parallel; each function is self-contained
                await Promise.all([
                    loadDashboardSummary(),
                    (state.activeView === "route") ? loadRouteDetails() : loadRouteDetails(),
                    (state.activeView === "driver-bus") ? loadDriverBusDetails() : loadDriverBusDetails(),
                    (state.activeView === "fee") ? loadFeeDetails() : loadFeeDetails(),
                    (state.activeView === "bus-pass") ? loadBusRequestAndPass() : Promise.resolve()
                ]);
                // If tracking map is open, refresh it so it shows the new bus
                if (state.activeView === "tracking" && state.map) {
                    loadLiveTracking();
                }
            }
        } catch (error) {
            console.error("Save profile error:", error);
            showToast(error.message || "Error saving profile", "error");
        } finally {
            if (btnSubmit) {
                btnSubmit.disabled = false;
                btnSubmit.textContent = "Save Changes";
            }
        }
    }

    // =========================================================
    // VIEW 3: MY ROUTE & STOPS
    // =========================================================
    async function loadRouteDetails() {
        try {
            const data = await apiFetch("/route");
            if (!data.success) {
                showToast(data.message || "Failed to load route details", "error");
                return;
            }

            const route = data.route;
            const stops = data.stops || [];
            const studentStopId = data.student_stop_id || route?.student_stop_id || state.transport?.stop_id || (stops.find(s => s.is_student_stop)?.stop_id);
            const applicableFee = Number(data.applicable_fee !== undefined ? data.applicable_fee : (route?.applicable_fee !== undefined ? route.applicable_fee : (route?.student_fee !== undefined ? route.student_fee : (state.fee ? state.fee.applicable_fee : 18000))));

            let studentStopName = data.student_stop_name || route?.student_stop_name || state.transport?.stop_name;
            if (!studentStopName || studentStopName === "---") {
                const foundStop = stops.find(s => s.stop_id === studentStopId || s.is_student_stop);
                if (foundStop) studentStopName = foundStop.stop_name;
            }
            if (!studentStopName || studentStopName === "---") {
                studentStopName = "pudipatla";
            }

            const titleEl = document.getElementById("routeCardTitle");
            const startEl = document.getElementById("routeStartLoc");
            const endEl = document.getElementById("routeEndLoc");
            const myStopEl = document.getElementById("routeStudentStop");
            const feeEl = document.getElementById("routeApplicableFee");
            const timeline = document.getElementById("routeStopsTimeline");

            if (!route) {
                if (titleEl) titleEl.textContent = "No Route Assigned Yet";
                if (timeline) {
                    timeline.innerHTML = `
                        <div class="stop-timeline-node">
                            <div class="stop-order-bubble">!</div>
                            <div class="stop-node-details">
                                <h4>No Route Assigned</h4>
                                <span>Please submit a bus request or contact the Transport Office.</span>
                            </div>
                        </div>
                    `;
                }
                return;
            }

            if (titleEl) titleEl.textContent = `Route: ${route.route_name}`;
            if (startEl) startEl.textContent = route.start_location || "Mr palli";
            if (endEl) endEl.textContent = route.end_location || "college";

            if (myStopEl) myStopEl.textContent = studentStopName;
            if (feeEl) feeEl.textContent = formatCurrency(applicableFee);

            // Render Stops Timeline
            if (timeline) {
                if (stops.length === 0) {
                    timeline.innerHTML = `<p style="padding:16px; color:var(--text-muted);">No stops registered for this route.</p>`;
                } else {
                    timeline.innerHTML = stops.map((s, idx) => {
                        const isStudentStop = Boolean(s.is_student_stop || (s.stop_id === studentStopId) || (s.stop_name && s.stop_name.toLowerCase() === studentStopName.toLowerCase()));
                        return `
                            <div class="stop-timeline-node ${isStudentStop ? 'is-student-stop' : ''}">
                                <div class="stop-order-bubble">${s.stop_order || (idx + 1)}</div>
                                <div class="stop-node-details">
                                    <h4>
                                        ${esc(s.stop_name)}
                                        ${isStudentStop ? '<span class="badge badge-info" style="font-size:10px; margin-left:8px;">★ Your Boarding Stop</span>' : ''}
                                    </h4>
                                    <span>${esc(s.location || "En-route Stop")}</span>
                                </div>
                                <div class="stop-distance-tag">
                                    ${s.distance_km ? `${s.distance_km} km to college` : '-- km'}
                                </div>
                            </div>
                        `;
                    }).join("");
                }
            }
        } catch (error) {
            console.error("Error loading route details:", error);
        }
    }

    // =========================================================
    // VIEW 4: MY DRIVER & BUS DETAILS
    // =========================================================
    async function loadDriverBusDetails() {
        try {
            const data = await apiFetch("/driver-bus");
            if (!data.success) {
                showToast(data.message || "Failed to load bus/driver", "error");
                return;
            }

            const alertBox = document.getElementById("busPendingAlert");
            const alertText = document.getElementById("busPendingAlertText");
            const contentGrid = document.getElementById("driverBusContent");

            if (data.is_pending || !data.bus) {
                if (alertBox) alertBox.style.display = "flex";
                if (alertText) {
                    alertText.textContent = data.message || "Your bus or driver assignment is pending approval from the Transport Office.";
                }
            } else {
                if (alertBox) alertBox.style.display = "none";
            }

            const bus = data.bus || {};
            const driver = data.driver || {};

            // Bus info
            const busNumber = document.getElementById("busCardNumber");
            const busReg = document.getElementById("busCardReg");
            const busRowNo = document.getElementById("busRowNumber");
            const busRowName = document.getElementById("busRowName");
            const busRowCap = document.getElementById("busRowCapacity");
            const busRowRoute = document.getElementById("busRowRoute");
            const busRowStatus = document.getElementById("busRowStatus");

            if (busNumber) busNumber.textContent = bus.bus_number || "Pending";
            if (busReg) busReg.textContent = bus.bus_name || "College Bus";
            if (busRowNo) busRowNo.textContent = bus.bus_number || "Awaiting Assignment";
            if (busRowName) busRowName.textContent = bus.bus_name || "VEMU IT Transport Vehicle";
            if (busRowCap) busRowCap.textContent = bus.capacity ? `${bus.capacity} Seats` : "Standard Seating";
            if (busRowRoute) busRowRoute.textContent = (state.transport && state.transport.route_name) ? state.transport.route_name : "---";
            if (busRowStatus) {
                busRowStatus.innerHTML = bus.status === "Active"
                    ? `<span class="badge badge-success">Active</span>`
                    : `<span class="badge badge-warning">${esc(bus.status || "Pending")}</span>`;
            }

            // Driver info
            const driverName = document.getElementById("driverCardName");
            const driverRowName = document.getElementById("driverRowName");
            const driverRowPhone = document.getElementById("driverPhoneLink");
            const driverRowEmail = document.getElementById("driverRowEmail");
            const driverRowLicense = document.getElementById("driverRowLicense");
            const driverRowStatus = document.getElementById("driverRowStatus");

            if (driverName) driverName.textContent = driver.name || "Awaiting Driver";
            if (driverRowName) driverRowName.textContent = driver.name || "Pending Assignment";
            if (driverRowPhone) {
                if (driver.phone_no) {
                    driverRowPhone.textContent = driver.phone_no;
                    driverRowPhone.href = `tel:${driver.phone_no}`;
                } else {
                    driverRowPhone.textContent = "---";
                    driverRowPhone.removeAttribute("href");
                }
            }
            if (driverRowEmail) driverRowEmail.textContent = driver.email || "---";
            if (driverRowLicense) driverRowLicense.textContent = driver.license_no || "---";
            const driverRowExperience = document.getElementById("driverRowExperience");
            if (driverRowExperience) {
                const expVal = (driver.experience !== null && driver.experience !== undefined && driver.experience !== "")
                    ? `${driver.experience} Years`
                    : "Not provided";
                driverRowExperience.textContent = expVal;
            }
            if (driverRowStatus) {
                driverRowStatus.innerHTML = driver.status === "Active"
                    ? `<span class="badge badge-success">Active &amp; On-Duty</span>`
                    : `<span class="badge badge-neutral">${esc(driver.status || "Pending")}</span>`;
            }
        } catch (error) {
            console.error("Error loading driver & bus:", error);
        }
    }

    // =========================================================
    // VIEW 5: FEE PAYMENT & HISTORY
    // =========================================================
    async function loadFeeDetails() {
        try {
            const data = await apiFetch("/fee");
            if (!data.success) {
                showToast(data.message || "Failed to load fee info", "error");
                return;
            }

            state.fee = data.fee;
            const fee = data.fee;
            const history = data.payments || [];

            // Route-changed banner
            let routeChangeBanner = document.getElementById("feeRouteChangedBanner");
            if (!routeChangeBanner) {
                // Create once if not in HTML
                routeChangeBanner = document.createElement("div");
                routeChangeBanner.id = "feeRouteChangedBanner";
                routeChangeBanner.className = "global-alert warning";
                routeChangeBanner.style.cssText = "margin-bottom:16px; display:none;";
                routeChangeBanner.innerHTML = `<span>⚠️</span><span id="feeRouteChangedText"></span>`;
                const feeView = document.getElementById("view-fee");
                if (feeView) feeView.insertBefore(routeChangeBanner, feeView.firstChild);
            }
            if (data.route_changed) {
                const routeName = data.route_name || "new route";
                document.getElementById("feeRouteChangedText").textContent =
                    `Route changed to "${routeName}". New fee: ${formatCurrency(fee.applicable_fee)}. Please pay to activate your new bus pass.`;
                routeChangeBanner.style.display = "flex";
            } else {
                routeChangeBanner.style.display = "none";
            }

            // Banner & Stop Info
            const bannerDue = document.getElementById("feeBannerOutstanding");
            const bannerSub = document.getElementById("feeBannerSubtext");
            if (bannerDue) bannerDue.textContent = formatCurrency(fee.outstanding_amount);

            const stopName = data.stop?.stop_name || data.stop_name || state.transport?.stop_name || (history[0] && history[0].stop_name) || "---";
            const distKm = data.stop?.distance_km || data.distance_km || state.transport?.distance_km || 0;

            if (bannerSub) {
                bannerSub.textContent = `Assigned stop: ${stopName} (${distKm} km from VEMU IT Campus)`;
            }

            // Metric cards
            const mApp = document.getElementById("feeMetricApplicable");
            const mStop = document.getElementById("feeMetricStop");
            const mPaid = document.getElementById("feeMetricPaid");
            const mDue = document.getElementById("feeMetricDue");
            const mDueLabel = document.getElementById("feeMetricDueLabel");
            const mBadge = document.getElementById("feeMetricBadge");

            if (mApp) mApp.textContent = formatCurrency(fee.applicable_fee);
            if (mStop) mStop.textContent = `Stop: ${stopName}`;
            if (mPaid) mPaid.textContent = formatCurrency(fee.amount_paid);
            if (mDue) {
                mDue.textContent = formatCurrency(fee.outstanding_amount);
                mDue.style.color = fee.outstanding_amount > 0 ? "var(--danger)" : "var(--success)";
            }
            if (mDueLabel) {
                mDueLabel.textContent = fee.outstanding_amount > 0 ? "Due for payment" : "Fully cleared";
            }
            if (mBadge) {
                if (fee.payment_status === "Paid") {
                    mBadge.className = "badge badge-success";
                    mBadge.textContent = "Fully Paid";
                } else if (fee.payment_status === "Partial") {
                    mBadge.className = "badge badge-warning";
                    mBadge.textContent = "Partial";
                } else {
                    mBadge.className = "badge badge-danger";
                    mBadge.textContent = "Unpaid";
                }
            }

            // Button state
            const btnPay = document.getElementById("btnOpenPayModal");
            if (btnPay) {
                if (fee.outstanding_amount <= 0) {
                    btnPay.disabled = true;
                    btnPay.className = "btn btn-secondary btn-lg";
                    btnPay.innerHTML = "✅ All Fees Cleared";
                } else {
                    btnPay.disabled = false;
                    btnPay.className = "btn btn-success btn-lg";
                    btnPay.innerHTML = `💳 Pay Outstanding (${formatCurrency(fee.outstanding_amount)})`;
                }
            }

            // History table
            const tbody = document.getElementById("paymentHistoryBody");
            if (tbody) {
                if (history.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align:center; padding:24px; color:var(--text-muted);">
                                No payment transactions recorded yet.
                            </td>
                        </tr>
                    `;
                } else {
                    tbody.innerHTML = history.map(p => {
                        const payDate = p.payment_date || p.date || p.created_at;
                        const payMethod = p.payment_method || p.payment_mode || p.method || p.mode || "Online UPI";
                        const payRef = p.transaction_ref || p.transaction_id || p.reference_no || "--";
                        const payAmount = Number(p.amount_paid !== undefined ? p.amount_paid : (p.amount !== undefined ? p.amount : 0));
                        const payStatus = p.payment_status || p.status || "Success";
                        const isSuccess = String(payStatus).toLowerCase() === "success";

                        return `
                            <tr>
                                <td>#TXN-${p.payment_id || p.id}</td>
                                <td>${formatDateTime(payDate)}</td>
                                <td><strong>${esc(payMethod)}</strong></td>
                                <td style="font-family:monospace; font-size:12px;">${esc(payRef)}</td>
                                <td style="font-weight:800; color:var(--deep-navy);">${formatCurrency(payAmount)}</td>
                                <td>
                                    <span class="badge ${isSuccess ? 'badge-success' : 'badge-danger'}">
                                        ${esc(payStatus)}
                                    </span>
                                </td>
                                <td>
                                    ${isSuccess ? `
                                        <button type="button" class="btn btn-secondary btn-sm" onclick="window.viewReceiptDetail(${p.payment_id || p.id})">
                                            🧾 View Receipt
                                        </button>
                                    ` : `
                                        <span style="color:var(--text-muted); font-size:11px;">N/A</span>
                                    `}
                                </td>
                            </tr>
                        `;
                    }).join("");
                }
            }
        } catch (error) {
            console.error("Error loading fee details:", error);
        }
    }

    function openPayModal() {
        const modal = document.getElementById("payFeeModal");
        if (!modal) return;

        const amtText = document.getElementById("modalPayAmountText");
        const routeText = document.getElementById("modalPayRouteText");

        if (amtText) {
            const outstanding = state.fee ? state.fee.outstanding_amount : 0;
            amtText.textContent = outstanding > 0 ? formatCurrency(outstanding) : "₹0 (No outstanding fee)";
        }
        if (routeText && state.transport) {
            routeText.textContent = `Route: ${state.transport.route_name || "---"} • Stop: ${state.transport.stop_name || "---"}`;
        }

        modal.showModal();
    }

    function closePayModal() {
        const modal = document.getElementById("payFeeModal");
        if (modal) modal.close();
    }

    async function handlePaySubmit(e) {
        e.preventDefault();
        const selectMethod = document.getElementById("selectPaymentMethod");
        const inputRef = document.getElementById("inputPaymentRef");
        const btnSubmit = document.getElementById("btnConfirmPay");
        const upiErr = document.getElementById("paymentUpiError");

        const method = selectMethod ? selectMethod.value : "UPI";
        const upiId = inputRef ? inputRef.value.trim() : "";
        const upiRegex = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}$/;

        if (!upiId) {
            if (upiErr) {
                upiErr.textContent = "UPI ID is required (e.g., yourname@bank).";
                upiErr.style.display = "block";
            }
            inputRef?.focus();
            return;
        }

        if (!upiRegex.test(upiId)) {
            if (upiErr) {
                upiErr.textContent = "Please enter a valid UPI ID (format: name@bank or username@upi).";
                upiErr.style.display = "block";
            }
            inputRef?.focus();
            return;
        }

        if (upiErr) upiErr.style.display = "none";

        if (btnSubmit) {
            btnSubmit.disabled = true;
            btnSubmit.textContent = "Processing Transaction...";
        }

        try {
            const data = await apiFetch("/pay", {
                method: "POST",
                body: JSON.stringify({
                    payment_method: method,
                    upi_id: upiId,
                    transaction_ref: `UPI-${upiId}-${Date.now().toString().slice(-4)}`,
                    remarks: `Transportation fee paid by student via ${method} (${upiId})`
                })
            });

            if (!data.success) {
                showToast(data.message || "Payment processing failed.", "error");
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.textContent = "Confirm & Pay Now";
                }
                return;
            }

            closePayModal();
            showToast(data.auto_pass_generated
                ? "🎉 Payment Successful! Bus pass for your new route has been generated."
                : "🎉 Payment Successful! Transaction verified in MySQL.", "success");

            // Refresh fee and summary
            await loadFeeDetails();
            await loadDashboardSummary();

            // If a new pass was auto-generated for the route change, refresh bus-pass section
            if (data.auto_pass_generated) {
                await loadBusRequestAndPass();
                if (state.activeView !== "bus-pass") {
                    showToast("🚌 Your new bus pass is ready in Bus Request / Pass section.", "info");
                }
            }

            // Open receipt view automatically
            if (data.receipt_id) {
                setTimeout(() => {
                    switchView("receipt");
                    window.viewReceiptDetail(data.receipt_id);
                }, 600);
            }
        } catch (error) {
            console.error("Payment error:", error);
            showToast(error.message || "Payment execution error.", "error");
            if (btnSubmit) {
                btnSubmit.disabled = false;
                btnSubmit.textContent = "Confirm & Pay Now";
            }
        }
    }

    // =========================================================
    // VIEW 6: MY RECEIPTS & PRINTING
    // =========================================================
    async function loadReceipts() {
        try {
            const data = await apiFetch("/receipts");
            if (!data.success) {
                showToast(data.message || "Failed to load receipts", "error");
                return;
            }

            state.receipts = data.receipts || [];
            const tbody = document.getElementById("receiptsListBody");

            if (tbody) {
                if (state.receipts.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">
                                No confirmed payment receipts found.
                            </td>
                        </tr>
                    `;
                } else {
                    tbody.innerHTML = state.receipts.map(r => {
                        const payDate = r.payment_date || r.date || r.created_at;
                        const payAmount = Number(r.amount_paid !== undefined ? r.amount_paid : (r.amount !== undefined ? r.amount : 0));
                        const payMethod = r.payment_method || r.payment_mode || r.method || r.mode || "Online UPI";

                        return `
                            <tr>
                                <td style="font-weight:800; color:var(--royal-blue);">${esc(r.receipt_number)}</td>
                                <td>${formatDateTime(payDate)}</td>
                                <td style="font-weight:800;">${formatCurrency(payAmount)}</td>
                                <td>${esc(payMethod)}</td>
                                <td><span class="badge badge-success">Verified</span></td>
                                <td>
                                    <button type="button" class="btn btn-secondary btn-sm" onclick="window.viewReceiptDetail(${r.payment_id || r.id})">
                                        👁️ View &amp; Print
                                    </button>
                                </td>
                            </tr>
                        `;
                    }).join("");
                }
            }

            // Auto-preview first receipt if none currently shown
            if (state.receipts.length > 0) {
                window.viewReceiptDetail(state.receipts[0].payment_id);
            }
        } catch (error) {
            console.error("Error loading receipts:", error);
        }
    }

    window.viewReceiptDetail = async function (paymentId) {
        try {
            const data = await apiFetch(`/receipts/${paymentId}`);
            if (!data.success || !data.receipt) {
                showToast("Unable to load receipt details.", "error");
                return;
            }

            const r = data.receipt;
            state.currentReceipt = r;
            const html = generateReceiptHTML(r);

            // 1. Show in dedicated Receipt Modal Dialog (accessible from any view)
            const modal = document.getElementById("receiptModalDialog");
            const modalBody = document.getElementById("receiptModalBody");
            if (modal && modalBody) {
                modalBody.innerHTML = html;
                if (typeof modal.showModal === "function") {
                    modal.showModal();
                } else {
                    modal.style.display = "block";
                }
            }

            // 2. Also populate the preview card in My Receipts view
            const card = document.getElementById("receiptDisplayCard");
            const container = document.getElementById("receiptPreviewContainer");

            if (card) card.style.display = "block";
            if (container) {
                container.innerHTML = html;
            }

            if (state.activeView === "receipt") {
                card.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
        } catch (error) {
            console.error("View receipt error:", error);
            showToast("Failed to load receipt details: " + (error.message || "Network error"), "error");
        }
    };

    function generateReceiptHTML(r) {
        const payDate = r.payment_date || r.date || r.created_at;
        const payAmount = Number(r.amount_paid !== undefined ? r.amount_paid : (r.amount !== undefined ? r.amount : 0));
        const payMethod = r.payment_method || r.payment_mode || r.method || r.mode || "Online UPI";
        const payRef = r.transaction_ref || r.transaction_id || r.reference_no || "--";

        return `
            <div style="max-width:760px; margin:0 auto; background:#FFFFFF; border:2px solid #DBEAFE; border-radius:12px; padding:32px; font-family:'Inter', sans-serif; color:#101B3F; box-shadow:0 4px 20px rgba(16,27,63,0.06);">
                <!-- Institute Header -->
                <div style="display:flex; align-items:center; justify-content:space-between; border-bottom:3px solid #2563EB; padding-bottom:18px; margin-bottom:20px;">
                    <div style="display:flex; align-items:center; gap:16px;">
                        <img src="../assets/images/vemu-logo.jpg" alt="VEMU Logo" style="width:58px; height:58px; object-fit:contain; border-radius:6px; border:1px solid #DBEAFE;">
                        <div>
                            <h2 style="font-size:20px; font-weight:900; color:#101B3F; margin:0; letter-spacing:-0.4px;">VEMU INSTITUTE OF TECHNOLOGY</h2>
                            <p style="font-size:11px; color:#475569; margin:2px 0 0;">Approved by AICTE, New Delhi &bull; Affiliated to JNTUA, Ananthapuramu</p>
                            <p style="font-size:11px; color:#0EA5E9; font-weight:700; margin:2px 0 0;">DEPARTMENT OF TRANSPORTATION &bull; CAMPUSGO SYSTEM</p>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="display:inline-block; background:#ECFDF5; color:#047857; border:1px solid #A7F3D0; font-size:11px; font-weight:800; padding:4px 10px; border-radius:20px; text-transform:uppercase;">
                            Verified Receipt
                        </div>
                        <div style="font-size:12px; font-weight:800; color:#101B3F; margin-top:6px; font-family:monospace;">${esc(r.receipt_number)}</div>
                    </div>
                </div>

                <div style="text-align:center; margin-bottom:22px;">
                    <h3 style="font-size:16px; font-weight:800; text-transform:uppercase; letter-spacing:1px; color:#2563EB; margin:0;">TRANSPORTATION FEE RECEIPT</h3>
                    <span style="font-size:11.5px; color:#64748B;">Academic Year: 2025–2026 &bull; Official Student Copy</span>
                </div>

                <!-- Info Grid -->
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px 24px; background:#F8FAFF; border:1px solid #DBEAFE; border-radius:8px; padding:18px 22px; margin-bottom:24px; font-size:13px;">
                    <div><span style="color:#64748B;">Student Name:</span> <strong style="color:#101B3F; margin-left:6px;">${esc(r.student_name)}</strong></div>
                    <div><span style="color:#64748B;">Roll Number:</span> <strong style="color:#101B3F; margin-left:6px; font-family:monospace;">${esc(r.roll_no)}</strong></div>
                    <div><span style="color:#64748B;">Department / Branch:</span> <strong style="color:#101B3F; margin-left:6px;">${esc(r.branch || "General")}</strong></div>
                    <div><span style="color:#64748B;">Payment Date:</span> <strong style="color:#101B3F; margin-left:6px;">${formatDateTime(payDate)}</strong></div>
                    <div><span style="color:#64748B;">Assigned Route:</span> <strong style="color:#101B3F; margin-left:6px;">${esc(r.route_name || "---")}</strong></div>
                    <div><span style="color:#64748B;">Designated Stop:</span> <strong style="color:#101B3F; margin-left:6px;">${esc(r.stop_name || "---")}</strong></div>
                    <div><span style="color:#64748B;">Payment Method:</span> <strong style="color:#101B3F; margin-left:6px;">${esc(payMethod)}</strong></div>
                    <div><span style="color:#64748B;">Transaction Ref:</span> <strong style="color:#101B3F; margin-left:6px; font-family:monospace;">${esc(payRef)}</strong></div>
                </div>

                <!-- Amount Box -->
                <div style="background:linear-gradient(135deg, #101B3F 0%, #192957 100%); color:#FFFFFF; border-radius:8px; padding:18px 24px; display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
                    <div>
                        <span style="font-size:11px; text-transform:uppercase; color:#93C5FD; font-weight:700; letter-spacing:0.5px;">Amount Paid (INR)</span>
                        <h2 style="font-size:26px; font-weight:900; color:#06B6D4; margin:2px 0 0;">${formatCurrency(payAmount)}</h2>
                    </div>
                    <div style="text-align:right;">
                        <span style="font-size:11px; color:#A7F3D0; font-weight:700;">Status</span>
                        <div style="font-size:14px; font-weight:800; color:#FFFFFF;">SUCCESS / CONFIRMED</div>
                    </div>
                </div>

                <!-- Signatures & Verification -->
                <div style="display:flex; justify-content:space-between; align-items:flex-end; border-top:1px dashed #CBD5E1; padding-top:20px; font-size:11.5px; color:#64748B;">
                    <div>
                        <p style="margin:0 0 2px;">This is a computer-verified institutional receipt.</p>
                        <p style="margin:0;">MySQL Record ID: #TXN-${r.payment_id} &bull; Generated by CampusGo VEMU IT</p>
                    </div>
                    <div style="text-align:center;">
                        <div style="font-family:'Brush Script MT', cursive, sans-serif; font-size:19px; color:#2563EB; transform:rotate(-3deg); height:22px; margin-bottom:-2px; font-weight:700;">Trinath</div>
                        <div style="width:140px; border-bottom:1.5px solid #101B3F; margin-bottom:4px;"></div>
                        <strong style="color:#101B3F;">Admin / Transport In-charge</strong><br>
                        <span>VEMU IT, P.Kothakota</span>
                    </div>
                </div>
            </div>
        `;
    }

    // =========================================================
    // VIEW 7: BUS REQUEST & MY BUS PASS
    // =========================================================
    async function loadBusRequestAndPass() {
        try {
            const data = await apiFetch("/bus-request");
            if (!data.success) {
                showToast(data.message || "Failed to load bus request", "error");
                return;
            }

            const req = data.request;
            const pass = data.pass;
            const transport = data.transport;
            state.busPass = pass;

            const pendingBox = document.getElementById("passPendingContainer");
            const pendingDetails = document.getElementById("passPendingDetails");
            const rejectedBox = document.getElementById("passRejectedContainer");
            const rejectedDetails = document.getElementById("passRejectedDetails");
            const notAppliedBox = document.getElementById("passNotAppliedContainer");
            const approvedBox = document.getElementById("passApprovedContainer");
            const passCard = document.getElementById("officialBusPassCard");
            const btnPrint = document.getElementById("btnPrintBusPass");
            const btnOpenApply = document.getElementById("btnOpenApplyPass");

            const routeChangedBox = document.getElementById("passRouteChangedContainer");
            const routeChangedDetails = document.getElementById("passRouteChangedDetails");

            // Hide all first (including new routeChangedBox)
            if (routeChangedBox) routeChangedBox.style.display = "none";
            if (pendingBox) pendingBox.style.display = "none";
            if (rejectedBox) rejectedBox.style.display = "none";
            if (notAppliedBox) notAppliedBox.style.display = "none";
            if (approvedBox) approvedBox.style.display = "none";
            if (btnPrint) btnPrint.style.display = "none";
            if (btnOpenApply) btnOpenApply.style.display = "none";

            // 0. Route was changed: show dedicated banner, hide old pass
            if (data.route_changed) {
                if (routeChangedBox) {
                    if (routeChangedDetails) {
                        const newRoute = data.transport?.route_name || "new route";
                        const newStop  = data.transport?.stop_name  || "new stop";
                        const newFee   = data.fee ? formatCurrency(data.fee.applicable_fee) : "";
                        routeChangedDetails.textContent =
                            `Your route was changed to "${newRoute}" (Stop: ${newStop}). ` +
                            (newFee ? `New fee: ${newFee}. ` : "") +
                            `Please pay the fee to receive your updated bus pass.`;
                    }
                    routeChangedBox.style.display = "flex";
                }
                return;
            }

            // 1. Genuine Active Bus Pass: Only if pass exists and has a pass number in MySQL
            if (pass && pass.pass_number && (pass.status === "Active" || !pass.status)) {
                if (approvedBox) approvedBox.style.display = "block";
                if (btnPrint) btnPrint.style.display = "inline-flex";
                if (btnOpenApply) btnOpenApply.style.display = "none";

                if (passCard) {
                    passCard.innerHTML = generateBusPassHTML(data);
                }
                return;
            }

            // 2. Pending Request: Awaiting admin review
            if (req && req.status === "Pending") {
                if (pendingBox) pendingBox.style.display = "flex";
                if (btnOpenApply) btnOpenApply.style.display = "none";
                if (pendingDetails) {
                    const reqDate = req.requested_at ? formatDateTime(req.requested_at) : "recently";
                    pendingDetails.textContent = `Your bus request was submitted on ${reqDate}. Waiting for Admin review and bus assignment.`;
                }
                return;
            }

            // 3. Rejected Request: Admin rejected
            if (req && req.status === "Rejected") {
                if (rejectedBox) rejectedBox.style.display = "flex";
                if (btnOpenApply) btnOpenApply.style.display = "inline-flex";
                if (rejectedDetails && req.admin_remarks) {
                    rejectedDetails.textContent = `Admin remarks: "${req.admin_remarks}". Please re-apply or contact the Transport Office.`;
                }
                return;
            }

            // 4. No Active Pass / Request (Deleted by admin or student has not applied yet)
            if (notAppliedBox) notAppliedBox.style.display = "block";
            if (btnOpenApply) btnOpenApply.style.display = "inline-flex";
        } catch (error) {
            console.error("Error loading bus request & pass:", error);
        }
    }

    function generateBusPassHTML(data) {
        const student = data.student || state.student || {};
        const transport = data.transport || state.transport || {};
        const pass = data.pass || {};

        const passNo = pass.pass_number || "";
        const validTill = pass.valid_to ? formatDate(pass.valid_to) : "---";
        const qrContent = `VEMU-PASS:${student.roll_no || ""}:${passNo}`;
        const rawPhoto = pass.passport_photo || (data.request && data.request.passport_photo) || student.passport_photo || "";
        const photoUrl = rawPhoto ? (rawPhoto.startsWith("http") ? rawPhoto : `${window.location.origin}${rawPhoto.startsWith('/') ? '' : '/'}${rawPhoto}`) : "";

        return `
            <div style="width:480px; max-width:95vw; background:#FFFFFF; border:3px solid #101B3F; border-radius:14px; overflow:hidden; box-shadow:0 12px 36px rgba(16,27,63,0.18); font-family:'Inter', sans-serif; position:relative;">
                <!-- Header -->
                <div style="background:linear-gradient(135deg, #101B3F 0%, #192957 60%, #2563EB 100%); color:#FFFFFF; padding:18px 20px; display:flex; align-items:center; gap:14px;">
                    <img src="../assets/images/vemu-logo.jpg" alt="VEMU Logo" style="width:52px; height:52px; object-fit:contain; border-radius:6px; background:#FFFFFF; padding:2px;">
                    <div style="flex:1;">
                        <h3 style="font-size:15px; font-weight:900; margin:0; line-height:1.2; letter-spacing:-0.3px;">VEMU INSTITUTE OF TECHNOLOGY</h3>
                        <p style="font-size:10px; color:#93C5FD; margin:2px 0 0;">P.Kothakota, Chittoor &bull; Transport Dept.</p>
                        <div style="margin-top:4px; display:inline-block; background:#06B6D4; color:#101B3F; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px; text-transform:uppercase;">
                            Student Bus Pass (2025–2026)
                        </div>
                    </div>
                </div>

                <!-- Body -->
                <div style="padding:20px; background:#FFFFFF;">
                    <!-- Top ID row -->
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
                        <div>
                            <span style="font-size:10px; text-transform:uppercase; color:#64748B; font-weight:800;">PASS NUMBER</span>
                            <div style="font-size:14px; font-weight:900; color:#2563EB; font-family:monospace;">${esc(passNo)}</div>
                        </div>
                        <div style="text-align:right;">
                            <span style="font-size:10px; text-transform:uppercase; color:#64748B; font-weight:800;">VALID TILL</span>
                            <div style="font-size:12px; font-weight:800; color:#10B981;">${validTill}</div>
                        </div>
                    </div>

                    <!-- Student Profile Info -->
                    <div style="display:flex; gap:16px; margin-bottom:16px; align-items:center;">
                        ${photoUrl ? `
                            <img src="${photoUrl}" alt="${esc(student.name || 'Student')}" style="width:68px; height:80px; object-fit:cover; border-radius:10px; border:2px solid #2563EB; box-shadow:0 4px 14px rgba(37,99,235,0.25); flex-shrink:0;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                            <div style="display:none; width:68px; height:80px; border-radius:10px; background:linear-gradient(135deg, #2563EB, #0EA5E9); color:#FFFFFF; font-size:26px; font-weight:900; align-items:center; justify-content:center; box-shadow:0 4px 14px rgba(37,99,235,0.3); flex-shrink:0;">
                                ${esc(student.name ? student.name.slice(0, 2).toUpperCase() : "ST")}
                            </div>
                        ` : `
                            <div style="width:68px; height:80px; border-radius:10px; background:linear-gradient(135deg, #2563EB, #0EA5E9); color:#FFFFFF; font-size:26px; font-weight:900; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 14px rgba(37,99,235,0.3); flex-shrink:0;">
                                ${esc(student.name ? student.name.slice(0, 2).toUpperCase() : "ST")}
                            </div>
                        `}
                        <div style="flex:1;">
                            <h4 style="font-size:16px; font-weight:900; color:#101B3F; margin:0;">${esc(student.name)}</h4>
                            <div style="font-size:12.5px; font-weight:800; color:#2563EB; font-family:monospace; margin-top:2px;">${esc(student.roll_no)}</div>
                            <div style="font-size:11.5px; color:#475569; margin-top:2px;">Branch: <strong>${esc(student.branch || "General")}</strong></div>
                        </div>
                    </div>

                    <!-- Transport Specs Grid -->
                    <div style="background:#F8FAFC; border:1.5px solid #DBEAFE; border-radius:8px; padding:12px 14px; margin-bottom:16px; display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; font-size:11.5px;">
                        <div><span style="color:#64748B;">Assigned Bus:</span> <strong style="color:#101B3F; margin-left:4px;">${esc(transport.bus_number || "BUS-01")}</strong></div>
                        <div><span style="color:#64748B;">Route:</span> <strong style="color:#101B3F; margin-left:4px;">${esc(transport.route_name || "Route 1")}</strong></div>
                        <div style="grid-column:1/-1;"><span style="color:#64748B;">Boarding Stop:</span> <strong style="color:#2563EB; margin-left:4px;">${esc(transport.stop_name || "Assigned Stop")}</strong></div>
                        <div style="grid-column:1/-1;"><span style="color:#64748B;">Driver Contact:</span> <strong style="color:#101B3F; margin-left:4px;">${esc(transport.driver_name || "Driver")} (${esc(transport.driver_phone || "---")})</strong></div>
                    </div>

                    <!-- QR code & Institutional Stamp Row -->
                    <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px dashed #CBD5E1; padding-top:14px;">
                        <!-- Inline SVG QR Code Simulation -->
                        <div style="text-align:center;">
                            <div style="width:68px; height:68px; border:1px solid #CBD5E1; border-radius:4px; padding:4px; background:#FFFFFF; display:flex; align-items:center; justify-content:center;">
                                <svg width="58" height="58" viewBox="0 0 100 100" fill="#101B3F">
                                    <rect x="0" y="0" width="30" height="30" fill="#101B3F" />
                                    <rect x="5" y="5" width="20" height="20" fill="#FFFFFF" />
                                    <rect x="10" y="10" width="10" height="10" fill="#101B3F" />
                                    <rect x="70" y="0" width="30" height="30" fill="#101B3F" />
                                    <rect x="75" y="5" width="20" height="20" fill="#FFFFFF" />
                                    <rect x="80" y="10" width="10" height="10" fill="#101B3F" />
                                    <rect x="0" y="70" width="30" height="30" fill="#101B3F" />
                                    <rect x="5" y="75" width="20" height="20" fill="#FFFFFF" />
                                    <rect x="10" y="80" width="10" height="10" fill="#101B3F" />
                                    <rect x="40" y="20" width="10" height="20" fill="#101B3F" />
                                    <rect x="55" y="10" width="10" height="10" fill="#101B3F" />
                                    <rect x="45" y="50" width="25" height="10" fill="#101B3F" />
                                    <rect x="70" y="65" width="25" height="25" fill="#101B3F" />
                                    <rect x="75" y="70" width="15" height="15" fill="#FFFFFF" />
                                    <rect x="80" y="75" width="5" height="5" fill="#101B3F" />
                                </svg>
                            </div>
                            <span style="font-size:8.5px; color:#64748B; font-weight:700;">SCAN TO VERIFY</span>
                        </div>

                        <!-- Officer Signature Stamp -->
                        <div style="text-align:right;">
                            <div style="font-family:'Brush Script MT', cursive, sans-serif; font-size:20px; color:#2563EB; transform:rotate(-4deg); margin-bottom:-4px; font-weight:700; letter-spacing:0.5px;">Trinath</div>
                            <div style="border-top:1.5px solid #101B3F; width:130px; margin-top:2px;"></div>
                            <span style="font-size:10px; font-weight:800; color:#101B3F; text-transform:uppercase;">Admin / Transport Officer</span>
                            <div style="font-size:9px; color:#64748B;">VEMU IT &bull; Authorized Signatory</div>
                        </div>
                    </div>
                </div>

                <!-- Footer Strip -->
                <div style="background:#101B3F; color:#FFFFFF; padding:6px 20px; font-size:9.5px; text-align:center; letter-spacing:0.4px;">
                    This pass is non-transferable &bull; Carry daily during bus travel
                </div>
            </div>
        `;
    }

    // Bus request application handlers
    async function loadAvailableRoutes() {
        try {
            const data = await apiFetch("/available-routes");
            if (data.success) {
                state.availableRoutes = data.routes || [];
                state.preferredRouteId = data.preferred_route_id;
                state.preferredStopId = data.preferred_stop_id;
                state.paymentAmount = data.payment_amount;
                populateApplyRouteDropdown();
            }
        } catch (error) {
            console.error("Error loading available routes:", error);
        }
    }

    function populateApplyRouteDropdown() {
        const selectRoute = document.getElementById("selectApplyRoute");
        const selectStop = document.getElementById("selectApplyStop");
        const feeText = document.getElementById("applyEstimatedFee");
        const noticeEl = document.getElementById("applyPaymentAutoNotice");
        if (!selectRoute) return;

        // Auto-detect route & stop from payment record / transport state
        const targetRouteId = state.preferredRouteId || (state.transport && state.transport.route_id) || null;
        const targetStopId = state.preferredStopId || (state.transport && state.transport.stop_id) || null;

        selectRoute.innerHTML = `<option value="">-- Choose Route --</option>` +
            state.availableRoutes.map(r => `
                <option value="${r.route_id}">${esc(r.route_name)} (${esc(r.start_location)} ➔ ${esc(r.end_location)})</option>
            `).join("");

        function updateStops(routeId, stopToSelect) {
            if (!selectStop) return;
            const selectedRoute = state.availableRoutes.find(r => Number(r.route_id) === Number(routeId));
            if (!selectedRoute || !selectedRoute.stops || selectedRoute.stops.length === 0) {
                selectStop.innerHTML = `<option value="">-- No stops available --</option>`;
                if (feeText) feeText.textContent = "--";
                return;
            }

            selectStop.innerHTML = `<option value="">-- Choose Boarding Stop --</option>` +
                selectedRoute.stops.map(s => `
                    <option value="${s.stop_id}" data-fee="${s.fee || 0}">${esc(s.stop_name)} (${s.distance_km || 0} km)</option>
                `).join("");

            if (stopToSelect) {
                selectStop.value = String(stopToSelect);
            }

            const activeOpt = selectStop.selectedOptions[0];
            if (activeOpt && activeOpt.value && feeText) {
                const fee = Number(activeOpt.dataset.fee || 0);
                feeText.textContent = fee > 0 ? formatCurrency(fee) : "Distance-based (₹12,000–₹18,000)";
            } else if (feeText) {
                feeText.textContent = "--";
            }

            selectStop.onchange = function () {
                const opt = selectStop.selectedOptions[0];
                if (opt && feeText) {
                    const fee = Number(opt.dataset.fee || 0);
                    feeText.textContent = fee > 0 ? formatCurrency(fee) : "Distance-based (₹12,000–₹18,000)";
                }
            };
        }

        selectRoute.onchange = function () {
            updateStops(Number(selectRoute.value), null);
            if (noticeEl && selectRoute.value !== String(targetRouteId)) {
                noticeEl.style.display = "none";
            }
        };

        // If a verified payment/transport route exists, automatically select both Route and Boarding Stop!
        if (targetRouteId) {
            selectRoute.value = String(targetRouteId);
            updateStops(Number(targetRouteId), targetStopId);
            if (noticeEl) {
                noticeEl.style.display = "flex";
            }
        } else {
            if (selectStop) selectStop.innerHTML = `<option value="">-- Choose Route First --</option>`;
            if (feeText) feeText.textContent = "--";
            if (noticeEl) noticeEl.style.display = "none";
        }
    }

    function resetPassportPhotoInput() {
        const photoInput = document.getElementById("applyPassportPhoto");
        const photoError = document.getElementById("passportPhotoError");
        const previewContainer = document.getElementById("passportPreviewContainer");
        const previewImg = document.getElementById("passportPhotoPreview");
        if (photoInput) photoInput.value = "";
        if (photoError) {
            photoError.textContent = "";
            photoError.style.display = "none";
        }
        if (previewContainer) previewContainer.style.display = "none";
        if (previewImg) previewImg.src = "";
    }

    function handlePassportPhotoChange(e) {
        const file = e.target.files[0];
        const photoError = document.getElementById("passportPhotoError");
        const previewContainer = document.getElementById("passportPreviewContainer");
        const previewImg = document.getElementById("passportPhotoPreview");

        if (!file) {
            if (previewContainer) previewContainer.style.display = "none";
            if (previewImg) previewImg.src = "";
            return;
        }

        const validExts = ["jpg", "jpeg", "png", "webp"];
        const ext = file.name.slice((file.name.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
        const validTypes = ["image/jpeg", "image/png", "image/webp"];

        if (!validTypes.includes(file.type) && !validExts.includes(ext)) {
            if (photoError) {
                photoError.textContent = "Please select a valid image (JPG, JPEG, PNG, WEBP).";
                photoError.style.display = "block";
            }
            if (previewContainer) previewContainer.style.display = "none";
            if (previewImg) previewImg.src = "";
            e.target.value = "";
            return;
        }

        if (file.size > 2 * 1024 * 1024) {
            if (photoError) {
                photoError.textContent = "Photo size exceeds 2 MB limit.";
                photoError.style.display = "block";
            }
            if (previewContainer) previewContainer.style.display = "none";
            if (previewImg) previewImg.src = "";
            e.target.value = "";
            return;
        }

        if (photoError) {
            photoError.textContent = "";
            photoError.style.display = "none";
        }

        const reader = new FileReader();
        reader.onload = function(evt) {
            if (previewImg) previewImg.src = evt.target.result;
            if (previewContainer) previewContainer.style.display = "block";
        };
        reader.readAsDataURL(file);
    }

    function openApplyPassModal() {
        resetPassportPhotoInput();
        loadAvailableRoutes();
        const modal = document.getElementById("applyPassModal");
        if (modal) modal.showModal();
    }

    function closeApplyPassModal() {
        resetPassportPhotoInput();
        const modal = document.getElementById("applyPassModal");
        if (modal) modal.close();
    }

    async function handleApplyPassSubmit(e) {
        e.preventDefault();
        const selectRoute = document.getElementById("selectApplyRoute");
        const selectStop = document.getElementById("selectApplyStop");
        const photoInput = document.getElementById("applyPassportPhoto");
        const photoError = document.getElementById("passportPhotoError");

        const routeId = Number(selectRoute ? selectRoute.value : 0);
        const stopId = Number(selectStop ? selectStop.value : 0);

        if (!routeId || !stopId) {
            showToast("Please select both a Route and a Boarding Stop.", "warning");
            return;
        }

        // CHANGE 1: Validate passport photo presence and format
        const photoFile = photoInput?.files?.[0];
        if (!photoFile) {
            if (photoError) {
                photoError.textContent = "Passport size photo is required.";
                photoError.style.display = "block";
            }
            showToast("Passport size photo is required.", "warning");
            return;
        }

        const validExts = ["jpg", "jpeg", "png", "webp"];
        const ext = photoFile.name.slice((photoFile.name.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
        if (!validExts.includes(ext)) {
            if (photoError) {
                photoError.textContent = "Please select a JPG, JPEG, PNG, or WEBP image.";
                photoError.style.display = "block";
            }
            showToast("Invalid photo type. Only JPG, JPEG, PNG, and WEBP allowed.", "error");
            return;
        }

        if (photoFile.size > 2 * 1024 * 1024) {
            if (photoError) {
                photoError.textContent = "Photo size exceeds 2 MB limit.";
                photoError.style.display = "block";
            }
            showToast("Photo must be smaller than 2 MB.", "error");
            return;
        }

        const formData = new FormData();
        formData.append("route_id", routeId);
        formData.append("stop_id", stopId);
        formData.append("passport_photo", photoFile);

        try {
            const data = await apiFetch("/bus-request", {
                method: "POST",
                body: formData
            });

            if (!data.success) {
                showToast(data.message || "Failed to submit bus request", "error");
                return;
            }

            closeApplyPassModal();
            showToast("Bus pass request submitted to Admin successfully!", "success");
            await loadDashboardSummary();
            await loadBusRequestAndPass();
        } catch (error) {
            console.error("Apply pass error:", error);
            showToast(error.message || "Failed to apply for pass", "error");
        }
    }

    // =========================================================
    // VIEW 8: LIVE BUS TRACKING & LEAFLET MAP
    // =========================================================
    function initOrUpdateMap() {
        const mapContainer = document.getElementById("studentLiveMap");
        if (!mapContainer) return;

        if (!state.map) {
            // Default center around VEMU IT Campus (P.Kothakota / Chittoor: 13.2504, 79.1352)
            const defaultLat = 13.2504;
            const defaultLng = 79.1352;

            state.map = L.map("studentLiveMap", {
                zoomControl: true,
                attributionControl: false
            }).setView([defaultLat, defaultLng], 13);

            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19
            }).addTo(state.map);
        } else {
            state.map.invalidateSize();
        }

        loadLiveTracking();
    }

    async function loadLiveTracking() {
        try {
            const data = await apiFetch("/live-tracking");
            const unassignedAlert = document.getElementById("trackUnassignedAlert");
            const inactiveAlert = document.getElementById("trackInactiveAlert");
            const trackMain = document.getElementById("trackMainContainer");

            // CHANGE 4: Replace tracking area with inactive alert if profile is inactive or tracking returned 403
            if (data.is_inactive || state.isProfileInactive) {
                if (inactiveAlert) inactiveAlert.style.display = "flex";
                if (unassignedAlert) unassignedAlert.style.display = "none";
                if (trackMain) trackMain.style.display = "none";
                return;
            } else {
                if (inactiveAlert) inactiveAlert.style.display = "none";
            }

            if (!data.success) {
                showToast(data.message || "Unable to load live tracking", "error");
                return;
            }

            if (data.is_unassigned) {
                if (inactiveAlert) inactiveAlert.style.display = "none";
                if (unassignedAlert) unassignedAlert.style.display = "flex";
                if (trackMain) trackMain.style.display = "none";
                return;
            } else {
                if (unassignedAlert) unassignedAlert.style.display = "none";
                if (trackMain) trackMain.style.display = "grid";
            }

            // HUD update
            const hudBus = document.getElementById("hudBusNumber");
            const hudDriver = document.getElementById("hudDriverName");
            const hudSpeed = document.getElementById("hudSpeed");
            const hudUpdated = document.getElementById("hudLastUpdated");
            const tripStatusText = document.getElementById("trackTripStatusText");
            const upcomingStopText = document.getElementById("trackUpcomingStop");

            if (hudBus) hudBus.textContent = data.bus_number || "BUS-01";
            if (hudDriver) hudDriver.textContent = data.driver_name || "Vijay Kumar";

            const loc = data.location || {};
            if (hudSpeed) hudSpeed.textContent = (loc.speed !== null && loc.speed !== undefined) ? `${loc.speed} km/h` : "0 km/h";
            if (hudUpdated) {
                hudUpdated.textContent = loc.last_updated ? formatDateTime(loc.last_updated) : "Just now";
            }

            if (tripStatusText) {
                if (data.is_on_trip) {
                    tripStatusText.innerHTML = `<span style="color:#10B981; font-weight:800;">ACTIVE ON TRIP</span>`;
                } else {
                    tripStatusText.innerHTML = `<span style="color:#64748B;">TRIP NOT STARTED (Depot / Campus)</span>`;
                }
            }

            // Stops checklist & markers
            const stops = data.route_stops || [];
            renderTrackingStopsChecklist(stops, upcomingStopText);

            if (state.map) {
                renderMapStopsAndBus(data);
            }
        } catch (error) {
            console.error("Error loading live tracking:", error);
        }
    }

    function renderTrackingStopsChecklist(stops, upcomingStopTextEl) {
        const checklist = document.getElementById("trackStopsChecklist");
        if (!checklist) return;

        if (stops.length === 0) {
            checklist.innerHTML = `<p style="padding:12px; color:var(--text-muted); font-size:12px;">No stops mapped for this route.</p>`;
            return;
        }

        let firstUpcoming = null;

        checklist.innerHTML = stops.map((s, idx) => {
            const isStudentStop = s.is_student_stop;
            let statusClass = "upcoming";
            let statusBadge = "Upcoming";

            if (s.progress === "completed") {
                statusClass = "completed";
                statusBadge = "Passed";
            } else if (s.progress === "reached") {
                statusClass = "reached";
                statusBadge = "Arrived";
                if (!firstUpcoming) firstUpcoming = s.stop_name;
            } else {
                if (!firstUpcoming) firstUpcoming = s.stop_name;
            }

            return `
                <div class="live-stop-item ${statusClass}" style="${isStudentStop ? 'border:2px solid #2563EB; font-weight:800;' : ''}">
                    <div>
                        <span style="font-weight:700;">#${idx + 1} ${esc(s.stop_name)}</span>
                        ${isStudentStop ? '<span style="font-size:9.5px; background:#2563EB; color:#FFF; padding:1px 5px; border-radius:4px; margin-left:4px;">Your Stop</span>' : ''}
                    </div>
                    <span class="badge ${s.progress === 'completed' ? 'badge-success' : (s.progress === 'reached' ? 'badge-info' : 'badge-neutral')}" style="font-size:10px;">
                        ${statusBadge}
                    </span>
                </div>
            `;
        }).join("");

        if (upcomingStopTextEl) {
            upcomingStopTextEl.textContent = firstUpcoming || "VEMU IT Campus";
        }
    }

    function renderMapStopsAndBus(data) {
        if (!state.map) return;

        // Clear existing markers
        state.stopMarkers.forEach(m => state.map.removeLayer(m));
        state.stopMarkers = [];
        if (state.routePolyline) {
            state.map.removeLayer(state.routePolyline);
            state.routePolyline = null;
        }

        const stops = data.route_stops || [];
        const validCoords = [];

        // Plot Stop Markers
        stops.forEach((s, idx) => {
            if (s.latitude && s.longitude) {
                const lat = Number(s.latitude);
                const lng = Number(s.longitude);
                validCoords.push([lat, lng]);

                const isStudentStop = s.is_student_stop;
                const markerColor = isStudentStop ? "#2563EB" : "#101B3F";

                const stopIcon = L.divIcon({
                    className: "custom-stop-marker",
                    html: `
                        <div style="background:${markerColor}; color:#FFFFFF; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:11px; border:2px solid #FFFFFF; box-shadow:0 2px 8px rgba(0,0,0,0.3);">
                            ${idx + 1}
                        </div>
                    `,
                    iconSize: [26, 26],
                    iconAnchor: [13, 13]
                });

                const marker = L.marker([lat, lng], { icon: stopIcon })
                    .bindPopup(`
                        <strong>Stop #${idx + 1}: ${esc(s.stop_name)}</strong><br>
                        ${isStudentStop ? '<span style="color:#2563EB; font-weight:bold;">★ Your Designated Boarding Stop</span>' : ''}
                    `)
                    .addTo(state.map);

                state.stopMarkers.push(marker);
            }
        });

        // Route Polyline
        if (validCoords.length >= 2) {
            state.routePolyline = L.polyline(validCoords, {
                color: "#2563EB",
                weight: 4,
                opacity: 0.7,
                dashArray: "6, 8"
            }).addTo(state.map);
        }

        // Bus GPS Location Marker
        const loc = data.location;
        if (loc && loc.latitude && loc.longitude) {
            const busLat = Number(loc.latitude);
            const busLng = Number(loc.longitude);

            const busIcon = L.divIcon({
                className: "custom-bus-gps-marker",
                html: `
                    <div style="background:linear-gradient(135deg, #10B981, #059669); color:#FFFFFF; width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:22px; border:3px solid #FFFFFF; box-shadow:0 4px 18px rgba(16,185,129,0.5); animation:pulse 2s infinite;">
                        🚌
                    </div>
                `,
                iconSize: [44, 44],
                iconAnchor: [22, 22]
            });

            if (!state.busMarker) {
                state.busMarker = L.marker([busLat, busLng], { icon: busIcon })
                    .bindPopup(`
                        <strong>${esc(data.bus_number || "Assigned Bus")}</strong><br>
                        Driver: ${esc(data.driver_name || "---")}<br>
                        Speed: ${loc.speed || 0} km/h
                    `)
                    .addTo(state.map);
            } else {
                state.busMarker.setLatLng([busLat, busLng]);
                state.busMarker.setPopupContent(`
                    <strong>${esc(data.bus_number || "Assigned Bus")}</strong><br>
                    Driver: ${esc(data.driver_name || "---")}<br>
                    Speed: ${loc.speed || 0} km/h
                `);
            }

            state.map.setView([busLat, busLng], 14, { animate: true });
        } else if (validCoords.length > 0) {
            state.map.fitBounds(L.latLngBounds(validCoords), { padding: [40, 40] });
        }
    }

    // =========================================================
    // REAL-TIME SOCKET.IO INTEGRATION
    // =========================================================
    function initSocketIO() {
        try {
            state.socket = io({
                transports: ["websocket", "polling"]
            });

            const socketDot = document.getElementById("socketDot");
            const socketText = document.getElementById("socketText");

            state.socket.on("connect", () => {
                console.log("Socket.IO connected to CampusGo server");
                if (socketDot) socketDot.className = "status-dot connected";
                if (socketText) socketText.textContent = "Live Sync";

                // Join student room
                state.socket.emit("joinStudentRoom", { student_id: studentId });
            });

            // CHANGE 4: Socket live tracking denied notification for inactive students
            state.socket.on("trackingDenied", () => {
                const inactiveAlert = document.getElementById("trackInactiveAlert");
                const unassignedAlert = document.getElementById("trackUnassignedAlert");
                const trackMain = document.getElementById("trackMainContainer");
                if (inactiveAlert) inactiveAlert.style.display = "flex";
                if (unassignedAlert) unassignedAlert.style.display = "none";
                if (trackMain) trackMain.style.display = "none";
            });

            state.socket.on("disconnect", () => {
                console.warn("Socket.IO disconnected");
                if (socketDot) socketDot.className = "status-dot";
                if (socketText) socketText.textContent = "Offline";
            });

            // Live Driver GPS updates
            state.socket.on("driverLocationUpdated", (data) => {
                if (state.transport && state.transport.bus_id === data.bus_id) {
                    const hudSpeed = document.getElementById("hudSpeed");
                    const hudUpdated = document.getElementById("hudLastUpdated");
                    if (hudSpeed) hudSpeed.textContent = `${data.speed || 0} km/h`;
                    if (hudUpdated) hudUpdated.textContent = formatDateTime(new Date());

                    if (state.map && data.latitude && data.longitude) {
                        const lat = Number(data.latitude);
                        const lng = Number(data.longitude);
                        if (state.busMarker) {
                            state.busMarker.setLatLng([lat, lng]);
                            if (state.activeView === "tracking") {
                                state.map.panTo([lat, lng], { animate: true });
                            }
                        }
                    }
                }
            });

            // Trip started
            state.socket.on("tripStarted", (data) => {
                if (state.transport && state.transport.bus_id === data.bus_id) {
                    showToast(`Driver started trip for ${state.transport.bus_number}!`, "success");
                    state.trip = { is_on_trip: true, trip_id: data.trip_id };
                    updateTripIndicator();
                    if (state.activeView === "tracking") loadLiveTracking();
                }
            });

            // Trip ended
            state.socket.on("tripEnded", (data) => {
                if (state.transport && state.transport.bus_id === data.bus_id) {
                    showToast(`Trip completed for ${state.transport.bus_number}.`, "info");
                    state.trip = { is_on_trip: false };
                    updateTripIndicator();
                    if (state.activeView === "tracking") loadLiveTracking();
                }
            });

            // Stop milestone progress
            state.socket.on("stopProgressUpdated", (data) => {
                if (state.transport && state.transport.bus_id === data.bus_id) {
                    if (state.activeView === "tracking") loadLiveTracking();
                }
            });

            // Admin approved bus pass / assigned bus
            state.socket.on("studentTransportUpdated", (data) => {
                if (!data || !data.student_id || data.student_id === studentId) {
                    loadDashboardSummary();
                    if (state.activeView === "bus-pass") loadBusRequestAndPass();
                }
            });

            // Bus passes updated / revoked by Admin
            state.socket.on("busPassesUpdated", () => {
                loadDashboardSummary();
                if (state.activeView === "bus-pass") loadBusRequestAndPass();
            });

            // Pass requests updated
            state.socket.on("passRequestsUpdated", () => {
                loadDashboardSummary();
                if (state.activeView === "bus-pass") loadBusRequestAndPass();
            });

            // Fees / payments updated
            state.socket.on("paymentsUpdated", () => {
                loadFeeDetails();
                loadDashboardSummary();
            });

            // Cancellation updated by Admin
            state.socket.on("cancellationUpdated", (data) => {
                if (!data || !data.student_id || data.student_id === studentId) {
                    if (data.status === "Approved") {
                        state.hasCancelledBooking = true;
                    }
                    loadCancellationDetails();
                    loadDashboardSummary();
                    loadStudentNotifications();
                    if (data.status === "Approved") {
                        showToast(`Your bus pass cancellation was approved. Fine: ₹${data.fine_amount}`, "info");
                    }
                }
            });

            // Real-time notifications
            state.socket.on("newNotification", (data) => {
                if (state.hasCancelledBooking && (data.sender_role === "driver" || data.bus_id || data.route_id)) {
                    return; // Skip notifications from cancelled bus/driver
                }
                loadStudentNotifications();
                showToast(`🔔 ${data.title}: ${data.message}`, "info");
            });
        } catch (error) {
            console.error("Socket.IO init error:", error);
        }
    }

    // =========================================================
    // 100% RELIABLE ZERO-BLANK-PAGE PRINTING TECHNIQUE
    // =========================================================
    function printDocumentDirect(htmlContent, documentTitle = "CampusGo_Document") {
        if (!htmlContent) return;

        // Populate dedicated container for manual Ctrl+P
        const container = document.getElementById("printOnlyContainer");
        if (container) container.innerHTML = htmlContent;

        // Hidden iframe printing
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
                iframeWin.focus();
                iframeWin.print();
            }, 300);
        } catch (e) {
            console.error("Iframe print error, falling back to window.print():", e);
            window.print();
        }
    }

    // =========================================================
    // LOGOUT HANDLER
    // =========================================================
    async function handleLogout() {
        try {
            await apiFetch("/logout", { method: "POST" });
        } catch (e) {}

        localStorage.removeItem("campusgoUser");
        localStorage.removeItem("campusgoRole");
        localStorage.removeItem("campusgoToken");

        if (state.socket) {
            state.socket.disconnect();
        }

        showToast("Signed out successfully. Redirecting...", "info");
        setTimeout(() => {
            window.location.href = "login.html?role=student";
        }, 500);
    }

    // =========================================================
    // EVENT LISTENERS BINDING
    // =========================================================
    function bindEventListeners() {
        // Navigation links
        document.querySelectorAll(".sidebar-nav .nav-link").forEach(link => {
            link.addEventListener("click", () => {
                const view = link.dataset.view;
                if (view) switchView(view);
            });
        });

        // Mobile menu toggle
        const btnToggle = document.getElementById("btnToggleSidebar");
        const sidebar = document.getElementById("sidebar");
        if (btnToggle && sidebar) {
            btnToggle.addEventListener("click", () => {
                sidebar.classList.toggle("open");
            });
        }

        // Logout
        const btnLogout = document.getElementById("btnLogout");
        if (btnLogout) btnLogout.addEventListener("click", handleLogout);

        // Dashboard quick shortcuts
        const qPay = document.getElementById("btnQuickPayFee");
        const qPass = document.getElementById("btnQuickViewPass");
        const qTrack = document.getElementById("btnQuickLiveTrack");
        const qEdit = document.getElementById("btnQuickEditProfile");
        const refreshDash = document.getElementById("btnRefreshDash");

        if (qPay) qPay.addEventListener("click", () => switchView("fee"));
        if (qPass) qPass.addEventListener("click", () => switchView("bus-pass"));
        if (qTrack) qTrack.addEventListener("click", () => switchView("tracking"));
        if (qEdit) qEdit.addEventListener("click", () => {
            switchView("profile");
            openEditProfileModal();
        });
        if (refreshDash) refreshDash.addEventListener("click", () => {
            loadDashboardSummary();
            showToast("Refreshed dashboard records.", "info");
        });

        // Dashboard card clicks
        document.querySelectorAll(".summary-card[data-action]").forEach(card => {
            card.addEventListener("click", () => {
                const act = card.dataset.action;
                if (act === "go-profile") switchView("profile");
                else if (act === "go-route") switchView("route");
                else if (act === "go-driver-bus") switchView("driver-bus");
                else if (act === "go-fee") switchView("fee");
                else if (act === "go-bus-pass") switchView("bus-pass");
            });
        });

        // Profile Edit Modal
        const btnOpenEdit = document.getElementById("btnOpenEditProfile");
        const btnCloseEdit = document.getElementById("btnCloseEditModal");
        const btnCancelEdit = document.getElementById("btnCancelEdit");
        const formEdit = document.getElementById("editProfileForm");

        if (btnOpenEdit) btnOpenEdit.addEventListener("click", openEditProfileModal);
        if (btnCloseEdit) btnCloseEdit.addEventListener("click", closeEditProfileModal);
        if (btnCancelEdit) btnCancelEdit.addEventListener("click", closeEditProfileModal);
        if (formEdit) formEdit.addEventListener("submit", handleProfileSubmit);

        // Fee Payment Modal
        const btnOpenPay = document.getElementById("btnOpenPayModal");
        const btnClosePay = document.getElementById("btnClosePayModal");
        const btnCancelPay = document.getElementById("btnCancelPay");
        const formPay = document.getElementById("payFeeForm");

        if (btnOpenPay) btnOpenPay.addEventListener("click", openPayModal);
        if (btnClosePay) btnClosePay.addEventListener("click", closePayModal);
        if (btnCancelPay) btnCancelPay.addEventListener("click", closePayModal);
        if (formPay) formPay.addEventListener("submit", handlePaySubmit);

        // Print Current Receipt
        const btnPrintRec = document.getElementById("btnPrintCurrentReceipt");
        if (btnPrintRec) {
            btnPrintRec.addEventListener("click", () => {
                if (state.currentReceipt) {
                    const html = generateReceiptHTML(state.currentReceipt);
                    printDocumentDirect(html, `VEMU_IT_Receipt_${state.currentReceipt.receipt_number}`);
                }
            });
        }

        // Receipt Modal Dialog Handlers
        const receiptModal = document.getElementById("receiptModalDialog");
        const btnCloseReceipt = document.getElementById("btnCloseReceiptModal");
        const btnModalPrintReceipt = document.getElementById("btnModalPrintReceipt");

        if (btnCloseReceipt && receiptModal) {
            btnCloseReceipt.addEventListener("click", () => {
                if (typeof receiptModal.close === "function") receiptModal.close();
                else receiptModal.style.display = "none";
            });
        }
        if (receiptModal) {
            receiptModal.addEventListener("click", (e) => {
                const rect = receiptModal.getBoundingClientRect();
                const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
                if (!isInDialog && typeof receiptModal.close === "function") {
                    receiptModal.close();
                }
            });
        }
        if (btnModalPrintReceipt) {
            btnModalPrintReceipt.addEventListener("click", () => {
                if (state.currentReceipt) {
                    const html = generateReceiptHTML(state.currentReceipt);
                    printDocumentDirect(html, `VEMU_IT_Receipt_${state.currentReceipt.receipt_number}`);
                }
            });
        }

        // Print Bus Pass
        const btnPrintPass = document.getElementById("btnPrintBusPass");
        if (btnPrintPass) {
            btnPrintPass.addEventListener("click", () => {
                const passCard = document.getElementById("officialBusPassCard");
                if (passCard && passCard.innerHTML.trim()) {
                    printDocumentDirect(passCard.innerHTML, `VEMU_IT_BusPass_${state.student ? state.student.roll_no : "Student"}`);
                }
            });
        }

        // Apply Bus Pass
        const btnOpenApply = document.getElementById("btnOpenApplyPass");
        const btnStartApply = document.getElementById("btnStartPassRequest");
        const btnReapply = document.getElementById("btnReapplyPass");
        const btnCloseApply = document.getElementById("btnCloseApplyModal");
        const btnCancelApply = document.getElementById("btnCancelApply");
        const formApply = document.getElementById("applyPassForm");

        if (btnOpenApply) btnOpenApply.addEventListener("click", openApplyPassModal);
        if (btnStartApply) btnStartApply.addEventListener("click", openApplyPassModal);
        if (btnReapply) btnReapply.addEventListener("click", openApplyPassModal);
        if (btnCloseApply) btnCloseApply.addEventListener("click", closeApplyPassModal);
        if (btnCancelApply) btnCancelApply.addEventListener("click", closeApplyPassModal);
        if (formApply) formApply.addEventListener("submit", handleApplyPassSubmit);

        // Passport Photo file change listener
        const applyPhotoInput = document.getElementById("applyPassportPhoto");
        if (applyPhotoInput) applyPhotoInput.addEventListener("change", handlePassportPhotoChange);

        // Refresh Tracking GPS
        const btnRefreshTrack = document.getElementById("btnRefreshTracking");
        if (btnRefreshTrack) {
            btnRefreshTrack.addEventListener("click", () => {
                loadLiveTracking();
                showToast("Refreshed bus GPS data.", "info");
            });
        }

        // Transportation Cancellation Form
        const cancelForm = document.getElementById("cancelPassForm");
        if (cancelForm) {
            cancelForm.addEventListener("submit", handleCancellationSubmit);
        }

        // Pay Fine Modal
        const btnCloseFine = document.getElementById("btnCloseFineModal");
        const btnCancelFine = document.getElementById("btnCancelFinePay");
        const formPayFine = document.getElementById("payFineForm");

        if (btnCloseFine) btnCloseFine.addEventListener("click", closePayFineModal);
        if (btnCancelFine) btnCancelFine.addEventListener("click", closePayFineModal);
        if (formPayFine) formPayFine.addEventListener("submit", handlePayFineSubmit);

        // Clear UPI error on typing
        const inputPaymentRef = document.getElementById("inputPaymentRef");
        if (inputPaymentRef) {
            inputPaymentRef.addEventListener("input", () => {
                const err = document.getElementById("paymentUpiError");
                if (err) err.style.display = "none";
            });
        }
        const inputFineUpiId = document.getElementById("inputFineUpiId");
        if (inputFineUpiId) {
            inputFineUpiId.addEventListener("input", () => {
                const err = document.getElementById("fineUpiError");
                if (err) err.style.display = "none";
            });
        }

        // Notification Center
        setupNotificationCenter();
    }

    // =========================================================
    // 8. TRANSPORTATION CANCELLATION CONTROLLER
    // =========================================================
    async function loadCancellationDetails() {
        try {
            const data = await apiFetch("/cancellations");
            if (!data.success) {
                showToast(data.message || "Failed to load cancellation info", "error");
                return;
            }

            const activePass = data.active_pass;
            const transport = data.active_transport;
            const pendingReq = data.pending_request;
            const history = data.cancellations || [];

            // 1. Render Current Transportation Grid
            const passNumEl = document.getElementById("cancelPassNumber");
            const routeNameEl = document.getElementById("cancelRouteName");
            const stopNameEl = document.getElementById("cancelStopName");
            const busNumEl = document.getElementById("cancelBusNumber");
            const amountEl = document.getElementById("cancelAmountPaid");
            const statusEl = document.getElementById("cancelPassStatus");

            if (activePass) {
                if (passNumEl) passNumEl.textContent = activePass.pass_number || "—";
                if (routeNameEl) routeNameEl.textContent = activePass.route_name || "—";
                if (stopNameEl) stopNameEl.textContent = activePass.stop_name || "—";
                if (busNumEl) busNumEl.textContent = activePass.bus_number || "—";
                const paidVal = (activePass.amount_paid !== null && activePass.amount_paid !== undefined && activePass.amount_paid !== "")
                    ? activePass.amount_paid
                    : (transport && transport.amount_paid ? transport.amount_paid : 0);
                if (amountEl) amountEl.textContent = formatCurrency(paidVal);
                if (statusEl) {
                    statusEl.textContent = activePass.status === "Active" ? "Active Pass" : (activePass.status || "Active Pass");
                    statusEl.className = "badge badge-success";
                }
            } else if (transport && transport.transport_status === "Active") {
                if (passNumEl) passNumEl.textContent = "No pass issued";
                if (routeNameEl) routeNameEl.textContent = transport.route_name || "—";
                if (stopNameEl) stopNameEl.textContent = transport.stop_name || "—";
                if (busNumEl) busNumEl.textContent = transport.bus_number || "—";
                if (amountEl) amountEl.textContent = transport.amount_paid ? formatCurrency(transport.amount_paid) : "—";
                if (statusEl) {
                    statusEl.textContent = "Active Transportation";
                    statusEl.className = "badge badge-info";
                }
            } else {
                if (passNumEl) passNumEl.textContent = "No active pass";
                if (routeNameEl) routeNameEl.textContent = "—";
                if (stopNameEl) stopNameEl.textContent = "—";
                if (busNumEl) busNumEl.textContent = "—";
                if (amountEl) amountEl.textContent = "—";
                if (statusEl) {
                    statusEl.textContent = "Deactivated";
                    statusEl.className = "badge badge-neutral";
                }
            }

            // 2. Render Decision / Pending Banner
            const decisionCard = document.getElementById("cancellationDecisionCard");
            const submitBtn = document.getElementById("btnSubmitCancel");

            if (pendingReq) {
                decisionCard.style.display = "block";
                decisionCard.className = "global-alert warning";
                decisionCard.innerHTML = `
                    <span>⏳</span>
                    <div>
                        <strong>Cancellation Request Pending Review:</strong>
                        <p style="margin:4px 0 0; font-size:12.5px;">Your request to switch to own transportation was submitted on <strong>${formatDateTime(pendingReq.requested_at)}</strong> and is currently awaiting Transportation Admin approval.</p>
                        <p style="margin:4px 0 0; font-size:12px; color:#92400E;"><strong>Reason:</strong> ${esc(pendingReq.reason)}</p>
                    </div>
                `;
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.textContent = "Request Already Pending";
                    submitBtn.style.opacity = "0.6";
                    submitBtn.style.cursor = "not-allowed";
                }
            } else {
                // Check if latest history was approved or rejected
                const latest = history[0];
                if (latest && latest.status === "Approved") {
                    const isPaid = latest.fine_payment_status === "Paid";
                    decisionCard.style.display = "block";
                    decisionCard.className = isPaid ? "global-alert success" : "global-alert warning";
                    decisionCard.innerHTML = `
                        <span>${isPaid ? '✅' : '⚠️'}</span>
                        <div style="flex:1;">
                            <strong>Transportation Cancellation Approved:</strong>
                            <p style="margin:4px 0 0; font-size:12.5px;">Your bus pass cancellation was approved on <strong>${formatDateTime(latest.reviewed_at)}</strong>. Your college bus pass and transportation assignment have been deactivated.</p>
                            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; margin-top:8px; gap:10px;">
                                <p style="margin:0; font-size:13.5px; font-weight:800; color:#DC2626;">
                                    Cancellation Fine: ₹${Number(latest.fine_amount || 0).toLocaleString("en-IN")}
                                    <span class="badge ${isPaid ? 'badge-success' : 'badge-warning'}" style="margin-left:8px; font-size:11px;">
                                        ${isPaid ? 'Paid in Full ✅' : 'Pending Payment ⚠️'}
                                    </span>
                                </p>
                                ${!isPaid && Number(latest.fine_amount || 0) > 0 ? `
                                    <button type="button" class="btn btn-primary" onclick="window.openPayFineModal(${latest.cancellation_id}, ${latest.fine_amount})" style="padding:7px 16px; font-size:13px; font-weight:700;">
                                        💳 Pay Cancellation Fee
                                    </button>
                                ` : ''}
                            </div>
                            ${isPaid && latest.fine_transaction_id ? `<p style="margin:4px 0 0; font-size:11.5px; color:#065F46;"><strong>Txn Ref:</strong> ${esc(latest.fine_transaction_id)} &bull; Paid: ${formatDateTime(latest.fine_paid_at)}</p>` : ''}
                            ${latest.admin_remarks ? `<p style="margin:3px 0 0; font-size:12px;"><strong>Remarks:</strong> ${esc(latest.admin_remarks)}</p>` : ""}
                        </div>
                    `;
                } else if (latest && latest.status === "Rejected") {
                    decisionCard.style.display = "block";
                    decisionCard.className = "global-alert info";
                    decisionCard.innerHTML = `
                        <span>❌</span>
                        <div>
                            <strong>Previous Cancellation Request Not Approved:</strong>
                            <p style="margin:4px 0 0; font-size:12.5px;">Your request submitted on ${formatDateTime(latest.requested_at)} was rejected. Remarks: <em>"${esc(latest.admin_remarks || 'None')}"</em>. Your bus pass remains active with no fine charged.</p>
                        </div>
                    `;
                } else {
                    decisionCard.style.display = "none";
                }

                if (submitBtn) {
                    if (!activePass && (!transport || transport.transport_status !== "Active")) {
                        submitBtn.disabled = true;
                        submitBtn.textContent = "No Active Pass to Cancel";
                        submitBtn.style.opacity = "0.6";
                        submitBtn.style.cursor = "not-allowed";
                    } else {
                        submitBtn.disabled = false;
                        submitBtn.textContent = "Submit Cancellation Request";
                        submitBtn.style.opacity = "1";
                        submitBtn.style.cursor = "pointer";
                    }
                }
            }

            // 3. Render Cancellation History Table
            const tbody = document.getElementById("cancelHistoryTableBody");
            if (tbody) {
                if (history.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">
                                No cancellation requests submitted yet.
                            </td>
                        </tr>
                    `;
                } else {
                    tbody.innerHTML = history.map(item => {
                        let statusBadge = `<span class="badge badge-warning">Pending</span>`;
                        if (item.status === "Approved") statusBadge = `<span class="badge badge-success">Approved</span>`;
                        else if (item.status === "Rejected") statusBadge = `<span class="badge badge-danger">Rejected</span>`;

                        const isPaid = item.fine_payment_status === "Paid";
                        const fineDisplay = item.status === "Approved"
                            ? `<strong style="color:#DC2626;">₹${Number(item.fine_amount || 0).toLocaleString("en-IN")}</strong>
                               <div style="margin-top:2px;">
                                 <span class="badge ${isPaid ? 'badge-success' : 'badge-warning'}" style="font-size:10px;">${isPaid ? 'Paid' : 'Unpaid'}</span>
                                 ${!isPaid && Number(item.fine_amount || 0) > 0 ? `<br><button type="button" class="btn btn-sm btn-primary" style="padding:3px 8px; font-size:11px; margin-top:4px;" onclick="window.openPayFineModal(${item.cancellation_id}, ${item.fine_amount})">Pay Fee</button>` : ''}
                               </div>`
                            : "—";

                        return `
                            <tr style="border-bottom: 1px solid #EDF2F9;">
                                <td style="padding:12px 16px; font-weight:700;">#${item.cancellation_id}</td>
                                <td style="padding:12px 16px;">${formatDateTime(item.requested_at)}</td>
                                <td style="padding:12px 16px; max-width:240px; overflow-wrap:break-word;">${esc(item.reason)}</td>
                                <td style="padding:12px 16px;">${statusBadge}</td>
                                <td style="padding:12px 16px;">${fineDisplay}</td>
                                <td style="padding:12px 16px; color:var(--text-secondary);">${esc(item.admin_remarks || "—")}</td>
                            </tr>
                        `;
                    }).join("");
                }
            }
        } catch (error) {
            console.error("Error loading cancellations:", error);
        }
    }

    async function handleCancellationSubmit(e) {
        e.preventDefault();
        const reasonSelect = document.getElementById("cancelReasonSelect");
        const reasonText = document.getElementById("cancelReasonText");
        const confirmCheck = document.getElementById("cancelConfirmCheck");
        const submitBtn = document.getElementById("btnSubmitCancel");

        if (!confirmCheck || !confirmCheck.checked) {
            showToast("Please check the confirmation box to proceed.", "error");
            return;
        }

        const primaryReason = reasonSelect ? reasonSelect.value.trim() : "";
        const detailedReason = reasonText ? reasonText.value.trim() : "";
        const fullReason = `${primaryReason}: ${detailedReason}`.slice(0, 255);

        if (!primaryReason || !detailedReason) {
            showToast("Please fill in both the primary reason and detailed explanation.", "error");
            return;
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Submitting...";
        }

        try {
            const data = await apiFetch("/cancellations", {
                method: "POST",
                body: JSON.stringify({ reason: fullReason })
            });

            if (data.success) {
                showToast(data.message || "Cancellation request submitted successfully.", "success");
                const form = document.getElementById("cancelPassForm");
                if (form) form.reset();
                loadCancellationDetails();
            } else {
                showToast(data.message || "Failed to submit request.", "error");
            }
        } catch (error) {
            showToast("Network error submitting cancellation request.", "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Submit Cancellation Request";
            }
        }
    }

    // =========================================================
    // 8B. PAY CANCELLATION FINE HANDLERS
    // =========================================================
    window.openPayFineModal = function(cancellationId, amount) {
        const modal = document.getElementById("payFineModal");
        const cancelIdInput = document.getElementById("payFineCancellationId");
        const amountText = document.getElementById("modalFineAmountText");
        const upiInput = document.getElementById("inputFineUpiId");
        const upiErr = document.getElementById("fineUpiError");

        if (cancelIdInput) cancelIdInput.value = cancellationId;
        if (amountText) amountText.textContent = `₹${Number(amount || 500).toLocaleString("en-IN")}`;
        if (upiInput) upiInput.value = "";
        if (upiErr) {
            upiErr.style.display = "none";
            upiErr.textContent = "";
        }

        if (modal) {
            if (typeof modal.showModal === "function") modal.showModal();
            else modal.style.display = "block";
        }
    };

    function closePayFineModal() {
        const modal = document.getElementById("payFineModal");
        if (modal) {
            if (typeof modal.close === "function") modal.close();
            else modal.style.display = "none";
        }
    }

    async function handlePayFineSubmit(e) {
        e.preventDefault();
        const cancelIdInput = document.getElementById("payFineCancellationId");
        const upiInput = document.getElementById("inputFineUpiId");
        const upiErr = document.getElementById("fineUpiError");
        const btnSubmit = document.getElementById("btnConfirmFinePay");

        const cancellationId = cancelIdInput ? cancelIdInput.value : null;
        const upiId = upiInput ? upiInput.value.trim() : "";
        const upiRegex = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}$/;

        if (!upiId) {
            if (upiErr) {
                upiErr.textContent = "UPI ID is required (e.g., yourname@bank).";
                upiErr.style.display = "block";
            }
            upiInput?.focus();
            return;
        }

        if (!upiRegex.test(upiId)) {
            if (upiErr) {
                upiErr.textContent = "Please enter a valid UPI ID (format: name@bank or username@upi).";
                upiErr.style.display = "block";
            }
            upiInput?.focus();
            return;
        }

        if (upiErr) upiErr.style.display = "none";

        if (btnSubmit) {
            btnSubmit.disabled = true;
            btnSubmit.textContent = "Processing Payment...";
        }

        try {
            const data = await apiFetch(`/cancellations/${cancellationId}/pay-fine`, {
                method: "POST",
                body: JSON.stringify({ upi_id: upiId })
            });

            if (!data.success) {
                showToast(data.message || "Failed to process cancellation fee.", "error");
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.textContent = "Pay Fine Now";
                }
                return;
            }

            closePayFineModal();
            showToast("🎉 Cancellation fee paid successfully! Status updated to Paid.", "success");
            await loadCancellationDetails();
            await loadFeeDetails();
            await loadDashboardSummary();
        } catch (error) {
            console.error("Pay fine error:", error);
            showToast(error.message || "Payment execution error.", "error");
            if (btnSubmit) {
                btnSubmit.disabled = false;
                btnSubmit.textContent = "Pay Fine Now";
            }
        }
    }

    // =========================================================
    // 9. STUDENT NOTIFICATION CENTER CONTROLLER
    // =========================================================
    async function loadStudentNotifications() {
        try {
            const data = await apiFetch("/notifications");
            if (!data.success) return;

            const notifs = data.notifications || [];
            const unreadCount = data.unread_count || 0;
            state.hasCancelledBooking = Boolean(data.has_cancelled_booking);

            const badge = document.getElementById("studentNotifBadge");
            if (badge) {
                if (unreadCount > 0) {
                    badge.style.display = "flex";
                    badge.textContent = unreadCount > 9 ? "9+" : unreadCount;
                } else {
                    badge.style.display = "none";
                }
            }

            const list = document.getElementById("studentNotifList");
            if (list) {
                if (notifs.length === 0) {
                    list.innerHTML = `<p class="notif-empty">No notifications yet.</p>`;
                } else {
                    list.innerHTML = notifs.map(n => `
                        <div class="notif-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.notification_id}">
                            <div class="notif-item-title">
                                <span>${esc(n.title)}</span>
                                <span style="font-size:10px; font-weight:600; color:#2563EB; text-transform:uppercase;">${esc(n.sender_role || 'Notice')}</span>
                            </div>
                            <div class="notif-item-msg">${esc(n.message)}</div>
                            <div class="notif-item-time">${formatDateTime(n.created_at)}</div>
                        </div>
                    `).join("");

                    list.querySelectorAll(".notif-item.unread").forEach(item => {
                        item.addEventListener("click", async () => {
                            const notifId = item.dataset.notifId;
                            if (notifId) {
                                await apiFetch(`/notifications/${notifId}/read`, { method: "PATCH" });
                                item.classList.remove("unread");
                                loadStudentNotifications();
                            }
                        });
                    });
                }
            }
        } catch (error) {
            console.error("Error loading notifications:", error);
        }
    }

    function setupNotificationCenter() {
        const btnNotifs = document.getElementById("btnStudentNotifs");
        const dropdown = document.getElementById("studentNotifDropdown");
        const btnMarkAll = document.getElementById("btnStudentMarkAllRead");

        if (btnNotifs && dropdown) {
            btnNotifs.addEventListener("click", (e) => {
                e.stopPropagation();
                const isOpen = dropdown.style.display === "block";
                dropdown.style.display = isOpen ? "none" : "block";
                if (!isOpen) loadStudentNotifications();
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
                await apiFetch("/notifications/read-all", { method: "PATCH" });
                loadStudentNotifications();
                showToast("All notifications marked as read.", "info");
            });
        }
    }

    // =========================================================
    // INITIALIZATION
    // =========================================================
    async function init() {
        bindEventListeners();
        await loadDashboardSummary();
        initSocketIO();
        loadStudentNotifications();

        // Check URL hash if deep-linking e.g. #view-fee or ?view=fee
        const urlParams = new URLSearchParams(window.location.search);
        const requestedView = urlParams.get("view");
        if (requestedView && viewTitles[requestedView]) {
            switchView(requestedView);
        }
    }

    document.addEventListener("DOMContentLoaded", init);

})();
