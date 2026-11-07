
document.addEventListener("DOMContentLoaded", function () {
    const API_BASE = "http://localhost:5000";

    // =====================================================
    // STATISTICS SECTION
    // =====================================================
    const statisticIds = {
        "total-buses": "totalBuses",
        "total-routes": "totalRoutes",
        "total-students": "totalStudents",
        "total-stops": "totalStops"
    };

    async function loadStatistics() {
        try {
            const response = await fetch(`${API_BASE}/api/stats`);

            if (!response.ok) {
                throw new Error("Unable to fetch statistics");
            }

            const data = await response.json();

            if (!data.success) {
                throw new Error("Statistics API returned an error");
            }

            Object.entries(statisticIds).forEach(
                ([elementId, dataKey]) => {
                    const element = document.getElementById(elementId);

                    if (element) {
                        element.textContent = data[dataKey];
                    }
                }
            );
        } catch (error) {
            console.error("CampusGo statistics error:", error);
        }
    }

    loadStatistics();

    // Receive live updates from the backend
    if (typeof io === "function") {
        const socket = io(API_BASE);

        socket.on("statsUpdated", function (data) {
            if (!data.success) return;

            Object.entries(statisticIds).forEach(
                ([elementId, dataKey]) => {
                    const element = document.getElementById(elementId);

                    if (element) {
                        element.textContent = data[dataKey];
                    }
                }
            );
        });

        socket.on("newNotification", function () {
            loadPublicAnnouncements();
        });

        socket.on("newAnnouncement", function () {
            loadPublicAnnouncements();
        });

        socket.on("announcementsUpdated", function () {
            loadPublicAnnouncements();
        });
    }

    // =====================================================
    // NAVIGATION NOTIFICATIONS DROPDOWN
    // =====================================================
    const navNotifWrapper = document.getElementById("navNotifWrapper");
    const navNotifBtn = document.getElementById("navNotifBtn");
    const navNotifBadge = document.getElementById("navNotifBadge");
    const navNotifList = document.getElementById("navNotifList");
    const navNotifCountPill = document.getElementById("navNotifCountPill");

    if (navNotifBtn && navNotifWrapper) {
        navNotifBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            navNotifWrapper.classList.toggle("open");
        });

        document.addEventListener("click", function (e) {
            if (!navNotifWrapper.contains(e.target)) {
                navNotifWrapper.classList.remove("open");
            }
        });
    }

    async function loadPublicAnnouncements() {
        if (!navNotifList) return;
        try {
            const response = await fetch(`${API_BASE}/api/public/announcements`);
            if (!response.ok) return;
            const data = await response.json();
            const list = data.announcements || [];

            if (navNotifBadge) {
                if (list.length > 0) {
                    navNotifBadge.textContent = list.length;
                    navNotifBadge.style.display = "inline-flex";
                } else {
                    navNotifBadge.style.display = "none";
                }
            }

            if (navNotifCountPill) {
                navNotifCountPill.textContent = `${list.length} update${list.length === 1 ? '' : 's'}`;
            }

            if (list.length === 0) {
                navNotifList.innerHTML = `<div class="nav-notif-empty">No announcements at this time</div>`;
                return;
            }

            navNotifList.innerHTML = list.map(item => {
                const isEmergency = String(item.type || "").toUpperCase() === "EMERGENCY";
                const icon = isEmergency ? "🚨" : "📢";
                let formattedTime = "Recent";
                if (item.created_at) {
                    const d = new Date(item.created_at);
                    if (!isNaN(d.getTime())) {
                        formattedTime = d.toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit"
                        });
                    }
                }
                const badgeClass = isEmergency ? "nav-notif-badge-emergency" : "nav-notif-badge-general";
                const typeText = isEmergency ? "Urgent / Emergency" : (item.type || "Notice");

                return `
                    <div class="nav-notif-item">
                        <span class="nav-notif-item-icon">${icon}</span>
                        <div class="nav-notif-item-content">
                            <div class="nav-notif-item-top">
                                <strong class="nav-notif-item-title">${escapeHtml(item.title || "Announcement")}</strong>
                                <span class="nav-notif-item-time">${formattedTime}</span>
                            </div>
                            <p class="nav-notif-item-message">${escapeHtml(item.message || "")}</p>
                            <span class="nav-notif-item-badge ${badgeClass}">${escapeHtml(typeText)}</span>
                        </div>
                    </div>
                `;
            }).join("");
        } catch (e) {
            console.warn("Could not load public announcements:", e);
        }
    }

    loadPublicAnnouncements();

    // =====================================================
    // COLLEGE BUS ROUTES DISPLAY
    // =====================================================
    const routesContainer = document.getElementById("routes-container");

    async function loadRoutes() {
        if (!routesContainer) return;

        routesContainer.innerHTML = `
            <div class="routes-loading">
                <div class="routes-spinner"></div>
                <p>Loading college bus routes from CampusGo...</p>
            </div>
        `;

        try {
            const response = await fetch(`${API_BASE}/api/routes`);

            if (!response.ok) {
                throw new Error(`Server returned status ${response.status}`);
            }

            const data = await response.json();

            if (!data.success || !Array.isArray(data.routes)) {
                throw new Error(data.message || "Invalid routes data format.");
            }

            if (data.routes.length === 0) {
                routesContainer.innerHTML = `
                    <div class="routes-empty">
                        <p>No routes are currently available.</p>
                    </div>
                `;
                return;
            }

            renderRoutes(data.routes);
        } catch (error) {
            console.error("Error loading routes:", error);
            routesContainer.innerHTML = `
                <div class="routes-error">
                    <p>Unable to load bus routes from CampusGo server.</p>
                    <button type="button" class="btn-retry" id="routes-retry-btn">Retry</button>
                </div>
            `;

            const retryBtn = document.getElementById("routes-retry-btn");
            if (retryBtn) {
                retryBtn.addEventListener("click", loadRoutes);
            }
        }
    }

    function renderRoutes(routes) {
        routesContainer.innerHTML = "";

        routes.forEach((route) => {
            const card = document.createElement("div");
            card.className = "route-card";

            const stopsList = Array.isArray(route.stops) ? route.stops : [];
            const stopsCount = route.stops_count || stopsList.length;

            let stopsHtml = "";
            if (stopsList.length > 0) {
                stopsHtml = `
                    <div class="route-stops-wrapper">
                        <h4 class="route-stops-title">Ordered Route Stops (${stopsCount})</h4>
                        <ol class="route-stops-list">
                            ${stopsList
                                .map((stop, index) => {
                                    const orderNum = stop.stop_order || index + 1;
                                    const stopName = escapeHtml(stop.stop_name || "Unnamed Stop");
                                    const location = escapeHtml(stop.location || "");
                                    const distance = stop.distance_km ? `${parseFloat(stop.distance_km).toFixed(2)} km` : "";
                                    
                                    const metaParts = [];
                                    if (location) metaParts.push(`Location: ${location}`);
                                    if (distance) metaParts.push(distance);
                                    const metaText = metaParts.join(" • ");

                                    return `
                                        <li class="route-stop-item">
                                            <div class="stop-order-num">${orderNum}</div>
                                            <div class="stop-details">
                                                <span class="stop-name">${stopName}</span>
                                                ${metaText ? `<span class="stop-meta">${metaText}</span>` : ""}
                                            </div>
                                        </li>
                                    `;
                                })
                                .join("")}
                        </ol>
                    </div>
                `;
            } else {
                stopsHtml = `
                    <div class="route-stops-wrapper">
                        <p class="stop-meta" style="font-style: italic; padding: 10px 0;">No stops currently assigned to this route.</p>
                    </div>
                `;
            }

            const busBadgeHtml = route.bus_number
                ? `<span class="route-bus-badge" title="Assigned Bus">🚌 ${escapeHtml(route.bus_number)}</span>`
                : "";

            card.innerHTML = `
                <div class="route-card-header">
                    <div class="route-title-wrap">
                        <span class="route-badge-id">Route</span>
                        <h3 class="route-title">${escapeHtml(route.route_name || "Bus Route")}</h3>
                    </div>
                    <div class="route-badges">
                        ${busBadgeHtml}
                        <span class="route-stops-badge">${stopsCount} ${stopsCount === 1 ? "Stop" : "Stops"}</span>
                    </div>
                </div>

                <div class="route-summary">
                    <div class="route-point">
                        <span class="point-label">From</span>
                        <strong class="point-value">${escapeHtml(route.start_location || "Starting Point")}</strong>
                    </div>
                    <div class="route-arrow">➔</div>
                    <div class="route-point" style="text-align: right;">
                        <span class="point-label">To</span>
                        <strong class="point-value">${escapeHtml(route.end_location || "Destination")}</strong>
                    </div>
                </div>

                ${stopsHtml}
            `;

            routesContainer.appendChild(card);
        });
    }

    loadRoutes();

    // =====================================================
    // CONTACT FORM SUBMISSION
    // =====================================================
    const contactForm = document.getElementById("contact-form");
    const nameInput = document.getElementById("contact-name");
    const emailInput = document.getElementById("contact-email");
    const messageInput = document.getElementById("contact-message");
    const submitBtn = document.getElementById("contact-submit-btn");
    const statusBox = document.getElementById("contact-status");

    function showContactStatus(type, message) {
        if (!statusBox) return;
        statusBox.className = `contact-status status-${type}`;
        statusBox.textContent = message;
        statusBox.style.display = "block";
    }

    function hideContactStatus() {
        if (!statusBox) return;
        statusBox.style.display = "none";
        statusBox.className = "contact-status";
        statusBox.textContent = "";
    }

    if (contactForm && nameInput && emailInput && messageInput && submitBtn) {
        contactForm.addEventListener("submit", async function (event) {
            event.preventDefault();
            hideContactStatus();

            const name = nameInput.value.trim();
            const email = emailInput.value.trim();
            const message = messageInput.value.trim();

            // Client-side validations
            if (!name) {
                showContactStatus("error", "Please enter your name.");
                nameInput.focus();
                return;
            }

            if (!email) {
                showContactStatus("error", "Please enter your email or phone number.");
                emailInput.focus();
                return;
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const phoneRegex = /^[0-9+\-\s()]{7,20}$/;
            if (!emailRegex.test(email) && !phoneRegex.test(email)) {
                showContactStatus("error", "Please provide a valid email address or phone number.");
                emailInput.focus();
                return;
            }

            if (!message) {
                showContactStatus("error", "Please enter your message.");
                messageInput.focus();
                return;
            }

            // Prevent duplicate submissions and show loading state
            submitBtn.disabled = true;
            const originalBtnText = submitBtn.textContent;
            submitBtn.textContent = "Sending...";

            try {
                const response = await fetch(`${API_BASE}/api/contact`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ name, email, message })
                });

                const data = await response.json();

                if (response.ok && data.success) {
                    showContactStatus("success", data.message || "Thank you! Your message has been sent successfully.");
                    contactForm.reset();
                } else {
                    showContactStatus("error", data.message || "Failed to send your message. Please try again.");
                }
            } catch (error) {
                console.error("Contact form submission error:", error);
                showContactStatus(
                    "error",
                    "Network error: Unable to reach the server. Please check your connection and try again."
                );
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalBtnText;
            }
        });
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
});
