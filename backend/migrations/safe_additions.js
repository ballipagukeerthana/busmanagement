require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'campusgo'
    });

    async function addColumnIfMissing(tableName, columnName, columnDefinition) {
        const [existing] = await db.query(`
            SELECT COLUMN_NAME 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
        `, [process.env.DB_NAME || 'campusgo', tableName, columnName]);

        if (existing.length === 0) {
            console.log(`Adding column ${columnName} to ${tableName}...`);
            await db.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
            console.log(`Added column ${columnName} successfully.`);
        } else {
            console.log(`Column ${columnName} already exists on ${tableName}.`);
        }
    }

    try {
        console.log('Running safe backwards-compatible migrations...');

        // 1. transport_cancellations additions
        await addColumnIfMissing('transport_cancellations', 'fine_amount', 'DECIMAL(10,2) DEFAULT 0.00 AFTER admin_remarks');
        await addColumnIfMissing('transport_cancellations', 'pass_id', 'INT NULL AFTER student_transport_id');
        await addColumnIfMissing('transport_cancellations', 'fine_payment_status', "VARCHAR(20) DEFAULT 'Pending' AFTER fine_amount");
        await addColumnIfMissing('transport_cancellations', 'fine_paid_at', 'DATETIME NULL AFTER fine_payment_status');
        await addColumnIfMissing('transport_cancellations', 'fine_transaction_id', 'VARCHAR(100) NULL AFTER fine_paid_at');

        // 2. notifications additions
        await addColumnIfMissing('notifications', 'sender_role', "VARCHAR(20) DEFAULT 'admin' AFTER type");
        await addColumnIfMissing('notifications', 'sender_id', 'INT DEFAULT NULL AFTER sender_role');
        await addColumnIfMissing('notifications', 'bus_id', 'INT DEFAULT NULL AFTER sender_id');
        await addColumnIfMissing('notifications', 'route_id', 'INT DEFAULT NULL AFTER bus_id');
        await addColumnIfMissing('notifications', 'is_public', 'TINYINT(1) DEFAULT 0 AFTER route_id');

        // 3. payments additions
        await addColumnIfMissing('payments', 'upi_id', 'VARCHAR(100) NULL');

        // 4. driver_requests and drivers experience column
        await addColumnIfMissing('driver_requests', 'experience', 'VARCHAR(50) DEFAULT NULL AFTER license_number');
        await addColumnIfMissing('drivers', 'experience', 'VARCHAR(50) DEFAULT NULL AFTER license_number');

        // 5. Ensure contact_messages table exists
        await db.query(`
            CREATE TABLE IF NOT EXISTS \`contact_messages\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`name\` VARCHAR(100) NOT NULL,
                \`email\` VARCHAR(255) NOT NULL,
                \`message\` TEXT NOT NULL,
                \`is_read\` TINYINT(1) DEFAULT 0,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        await addColumnIfMissing('contact_messages', 'is_read', 'TINYINT(1) DEFAULT 0');
        console.log('contact_messages table checked/created.');

        console.log('Safe migrations applied successfully.');

        const [cCols] = await db.query('DESCRIBE transport_cancellations');
        console.log('transport_cancellations columns:', cCols.map(c => c.Field));

        const [pCols] = await db.query('DESCRIBE payments');
        console.log('payments columns:', pCols.map(c => c.Field));

        const [nCols] = await db.query('DESCRIBE notifications');
        console.log('notifications columns:', nCols.map(c => c.Field));

    } catch (err) {
        console.error('Migration error:', err);
    } finally {
        await db.end();
    }
}

migrate();

