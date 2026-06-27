require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function main() {
    const username = String(process.env.ADMIN_USERNAME || '').trim();
    const password = String(process.env.ADMIN_PASSWORD || '');
    const fullName = String(process.env.ADMIN_FULL_NAME || '').trim();
    const dbPassword = String(process.env.DB_PASSWORD || '');

    if (!username || !fullName || password.length < 12) {
        throw new Error(
            'Задайте ADMIN_USERNAME, ADMIN_FULL_NAME и ADMIN_PASSWORD длиной не менее 12 символов'
        );
    }
    if (!dbPassword) {
        throw new Error('DB_PASSWORD обязателен');
    }

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'psyagent_user',
        password: dbPassword,
        database: process.env.DB_NAME || 'psych_diagnostic',
        charset: 'utf8mb4'
    });

    try {
        const [existing] = await connection.execute(
            'SELECT id FROM users WHERE username = ?',
            [username]
        );
        if (existing.length) {
            throw new Error(`Пользователь «${username}» уже существует`);
        }
        const hash = await bcrypt.hash(password, 12);
        await connection.execute(
            `INSERT INTO users (username, password, full_name, role, email)
             VALUES (?, ?, ?, 'admin', ?)`,
            [username, hash, fullName, process.env.ADMIN_EMAIL || null]
        );
        console.log(`Администратор «${username}» создан. Пароль в журнал не выводится.`);
    } finally {
        await connection.end();
    }
}

main().catch(error => {
    console.error(`Ошибка создания администратора: ${error.message}`);
    process.exitCode = 1;
});
