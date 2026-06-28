require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const password = String(process.env.DEFAULT_STUDENT_PASSWORD || '').trim();
if (password.length < 8) {
    console.error('Задайте DEFAULT_STUDENT_PASSWORD длиной не менее 8 символов в .env');
    process.exit(1);
}

const baseConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'psyagent_user',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4'
};
const controlDb = process.env.CONTROL_DB_NAME || 'psych_control';
const verifyOnly = process.argv.includes('--verify-only');

(async () => {
    const control = await mysql.createConnection({ ...baseConfig, database: controlDb });
    try {
        const [tenants] = await control.execute(
            'SELECT code, db_name FROM tenants ORDER BY id'
        );
        const hash = verifyOnly ? null : await bcrypt.hash(password, 10);
        let total = 0;
        for (const tenant of tenants) {
            if (!/^[a-zA-Z0-9_]+$/.test(tenant.db_name)) {
                throw new Error(`Недопустимое имя БД у колледжа ${tenant.code}`);
            }
            const db = await mysql.createConnection({ ...baseConfig, database: tenant.db_name });
            try {
                if (!verifyOnly) {
                    await db.execute(
                        `UPDATE users
                         SET password = ?, token_version = token_version + 1
                         WHERE role = 'student'`,
                        [hash]
                    );
                }
                const [students] = await db.execute(
                    "SELECT id, password FROM users WHERE role = 'student'"
                );
                const checks = await Promise.all(
                    students.map(student => bcrypt.compare(password, student.password))
                );
                if (checks.some(valid => !valid)) {
                    throw new Error(`Проверка паролей не пройдена в колледже ${tenant.code}`);
                }
                const [anonymousTables] = await db.execute(
                    `SELECT TABLE_NAME
                     FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = ?
                       AND TABLE_NAME IN ('anonymous_campaigns', 'anonymous_responses')`,
                    [tenant.db_name]
                );
                if (anonymousTables.length !== 2) {
                    throw new Error(`Схема анонимных опросов не готова в колледже ${tenant.code}`);
                }
                total += students.length;
                console.log(`${tenant.code}: проверено студентов — ${students.length}`);
            } finally {
                await db.end();
            }
        }
        console.log(
            verifyOnly
                ? `Проверка завершена: ${total} студентов, ${tenants.length} колледжей.`
                : `Готово. Пароль обновлён и проверен у ${total} студентов в ${tenants.length} колледжах.`
        );
    } finally {
        await control.end();
    }
})().catch(error => {
    console.error(`Сброс паролей не выполнен: ${error.message}`);
    process.exit(1);
});
