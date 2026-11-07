CREATE DATABASE campusgo;

CREATE TABLE students (
    student_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    branch VARCHAR(100) NOT NULL,
    roll_no VARCHAR(10) NOT NULL UNIQUE
        CHECK (roll_no REGEXP '^[A-Za-z0-9]{10}$'),
    phone_no VARCHAR(10) NOT NULL UNIQUE
        CHECK (phone_no REGEXP '^[0-9]{10}$'),
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(100) NOT NULL
);

CREATE TABLE admins (
    admin_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone_no VARCHAR(10) NOT NULL UNIQUE
        CHECK (phone_no REGEXP '^[0-9]{10}$'),
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(100) NOT NULL
);

CREATE TABLE drivers (
    driver_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone_no VARCHAR(10) NOT NULL UNIQUE
        CHECK (phone_no REGEXP '^[0-9]{10}$'),
    email VARCHAR(100) NOT NULL UNIQUE,
    license_no VARCHAR(30) NOT NULL UNIQUE,
    password VARCHAR(100) NOT NULL
);

CREATE TABLE buses (
    bus_id INT AUTO_INCREMENT PRIMARY KEY,
    bus_number VARCHAR(20) NOT NULL UNIQUE,
    bus_name VARCHAR(100),
    capacity INT NOT NULL,
    status VARCHAR(20) DEFAULT 'Available'
);


CREATE TABLE routes (
    route_id INT AUTO_INCREMENT PRIMARY KEY,
    route_name VARCHAR(100) NOT NULL,
    start_location VARCHAR(100) NOT NULL,
    end_location VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'Active'
);

CREATE TABLE stops (
    stop_id INT AUTO_INCREMENT PRIMARY KEY,
    stop_name VARCHAR(100) NOT NULL,
    location VARCHAR(200),
    status VARCHAR(20) DEFAULT 'Active'
);


CREATE TABLE route_stops (
    route_stop_id INT AUTO_INCREMENT PRIMARY KEY,
    route_id INT NOT NULL,
    stop_id INT NOT NULL,
    stop_order INT NOT NULL,

    FOREIGN KEY (route_id) REFERENCES routes(route_id),
    FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
);


CREATE TABLE bus_assignments (
    assignment_id INT AUTO_INCREMENT PRIMARY KEY,
    bus_id INT NOT NULL,
    driver_id INT NOT NULL,
    assignment_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'Active',

    FOREIGN KEY (bus_id) REFERENCES buses(bus_id),
    FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
);

CREATE TABLE student_transport (
    transport_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    route_id INT NOT NULL,
    bus_id INT NOT NULL,
    stop_id INT NOT NULL,
    status VARCHAR(20) DEFAULT 'Active',

    FOREIGN KEY (student_id) REFERENCES students(student_id),
    FOREIGN KEY (route_id) REFERENCES routes(route_id),
    FOREIGN KEY (bus_id) REFERENCES buses(bus_id),
    FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
);

CREATE TABLE fees (
    fee_id INT AUTO_INCREMENT PRIMARY KEY,
    stop_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    academic_year VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'Active',

    FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
);

CREATE TABLE payments (
    payment_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    fee_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    transaction_id VARCHAR(100) UNIQUE,
    payment_status VARCHAR(20) DEFAULT 'Pending',
    payment_date DATETIME,

    FOREIGN KEY (student_id) REFERENCES students(student_id),
    FOREIGN KEY (fee_id) REFERENCES fees(fee_id)
);

CREATE TABLE bus_passes (
    pass_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    roll_no VARCHAR(10) NOT NULL,
    stop_name VARCHAR(100) NOT NULL,
    route_name VARCHAR(100) NOT NULL,
    bus_number VARCHAR(20) NOT NULL,
    amount_paid DECIMAL(10,2) NOT NULL,
    pass_number VARCHAR(50) NOT NULL UNIQUE,
    issue_date DATE NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'Active',

    FOREIGN KEY (student_id) REFERENCES students(student_id)
);
CREATE TABLE trips (
    trip_id INT AUTO_INCREMENT PRIMARY KEY,
    bus_id INT NOT NULL,
    driver_id INT NOT NULL,
    route_id INT NOT NULL,
    start_time DATETIME,
    end_time DATETIME,
    status VARCHAR(20) DEFAULT 'Not Started',

    FOREIGN KEY (bus_id) REFERENCES buses(bus_id),
    FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
    FOREIGN KEY (route_id) REFERENCES routes(route_id)
);

CREATE TABLE live_locations (
    location_id INT AUTO_INCREMENT PRIMARY KEY,
    trip_id INT NOT NULL,
    bus_id INT NOT NULL,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    recorded_at DATETIME NOT NULL,

    FOREIGN KEY (trip_id) REFERENCES trips(trip_id),
    FOREIGN KEY (bus_id) REFERENCES buses(bus_id)
);

USE campusgo;

ALTER TABLE students
ADD COLUMN year VARCHAR(20) NOT NULL AFTER branch;

-- CHANGE 1: Add passport_photo to bus_pass_requests
ALTER TABLE bus_pass_requests ADD COLUMN passport_photo VARCHAR(255) NULL;

-- CHANGE 2: Add license_photo to driver_requests (for pending driver registrations)
ALTER TABLE driver_requests ADD COLUMN license_photo VARCHAR(255) NULL;

-- CHANGE 2: Add license_photo to drivers (for active driver accounts)
ALTER TABLE drivers ADD COLUMN license_photo VARCHAR(255) NULL;

