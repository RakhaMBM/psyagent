require('dotenv').config({ quiet: true });
const express = require('express');
const mysql2 = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const {
    findMethodologyByTitle,
    scoreMethodology
} = require('./public/methodologies');
const { PSY_ANONYMOUS_SURVEYS, isAnonymousQuestionVisible } = require('./public/anonymous-surveys');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

function requiredProductionEnv(name) {
    const value = String(process.env[name] || '').trim();
    if (IS_PRODUCTION && !value) {
        throw new Error(`В production обязательна переменная окружения ${name}`);
    }
    return value;
}

function validateConfiguredSecret(name, value, minimumLength) {
    if (!value) return;
    if (value.length < minimumLength || /replace|changeme|example/i.test(value)) {
        throw new Error(`${name} должен быть уникальным секретом длиной не менее ${minimumLength} символов`);
    }
}

function validateDatabasePassword(value) {
    if (!value) return;
    if (/replace|changeme|example/i.test(value)) {
        throw new Error('DB_PASSWORD содержит демонстрационное значение');
    }
    if (value.length < 12) {
        console.warn(
            ' DB_PASSWORD короче 12 символов. Приложение продолжит запуск для совместимости, ' +
            'но пароль MySQL рекомендуется планово усилить.'
        );
    }
}

const configuredJwtSecret = requiredProductionEnv('JWT_SECRET');
const JWT_SECRET = configuredJwtSecret || crypto.randomBytes(48).toString('hex');
const DB_PASSWORD = requiredProductionEnv('DB_PASSWORD');
const SUPERADMIN_PASSWORD = requiredProductionEnv('SUPERADMIN_PASSWORD');
const DEFAULT_STUDENT_PASSWORD = String(process.env.DEFAULT_STUDENT_PASSWORD || '').trim();
validateConfiguredSecret('JWT_SECRET', configuredJwtSecret, 32);
validateDatabasePassword(DB_PASSWORD);
validateConfiguredSecret('SUPERADMIN_PASSWORD', SUPERADMIN_PASSWORD, 12);
if (DEFAULT_STUDENT_PASSWORD && DEFAULT_STUDENT_PASSWORD.length < 8) {
    throw new Error('DEFAULT_STUDENT_PASSWORD должен быть не короче 8 символов');
}

// ИИ-анализ через Open Web UI (OpenAI-совместимый API). Необязательная функция:
// без полного набора переменных фича отключена, интерфейс скрывает кнопки.
const OPENWEBUI_BASE_URL = String(process.env.OPENWEBUI_BASE_URL || '').trim().replace(/\/+$/, '');
const OPENWEBUI_API_KEY = String(process.env.OPENWEBUI_API_KEY || '').trim();
const OPENWEBUI_MODEL = String(process.env.OPENWEBUI_MODEL || '').trim();
const OPENWEBUI_TIMEOUT_MS = Math.max(10000, Number(process.env.OPENWEBUI_TIMEOUT_MS) || 120000);
const AI_ANALYSIS_ENABLED = Boolean(OPENWEBUI_BASE_URL && OPENWEBUI_API_KEY && OPENWEBUI_MODEL);
if (!AI_ANALYSIS_ENABLED && (OPENWEBUI_BASE_URL || OPENWEBUI_API_KEY || OPENWEBUI_MODEL)) {
    console.warn(' ИИ-анализ отключён: задайте все три переменные OPENWEBUI_BASE_URL, OPENWEBUI_API_KEY и OPENWEBUI_MODEL.');
}

if (!configuredJwtSecret) {
    console.warn(' JWT_SECRET не задан: используется временный случайный ключ только для этой сессии.');
}
if (!DB_PASSWORD) {
    console.warn(' DB_PASSWORD не задан: подключение к MySQL выполняется с пустым паролем.');
}

// Middleware
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; script-src-attr 'none'; " +
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; " +
        "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    next();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// МУЛЬТИАРЕНДНОСТЬ: отдельная БД на каждый колледж (tenant)
// ============================================
// Базовая конфигурация подключения (без конкретной БД) — переиспользуется
// для control-БД, БД по умолчанию и БД отдельных колледжей.
const baseDbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'psyagent_user',
    password: DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    charset: 'utf8mb4'
};

const DEFAULT_DB_NAME = process.env.DB_NAME || 'psych_diagnostic';
const CONTROL_DB_NAME = process.env.CONTROL_DB_NAME || 'psych_control';
const TENANT_DB_PREFIX = safeDbName(process.env.TENANT_DB_PREFIX || 'psych_t_');
if (!TENANT_DB_PREFIX || !TENANT_DB_PREFIX.endsWith('_')) {
    throw new Error('TENANT_DB_PREFIX должен содержать безопасный префикс и заканчиваться подчёркиванием');
}

// БД «колледжа по умолчанию» (текущая) — чтобы существующий вход без кода колледжа работал.
const pool = mysql2.createPool({ ...baseDbConfig, database: DEFAULT_DB_NAME });

// Пул без указания БД — для административных операций (CREATE DATABASE при провижининге).
const adminPool = mysql2.createPool({ ...baseDbConfig });

// Control-БД (реестр колледжей и супер-админов).
let controlPool = null;

// Кэш пулов по имени БД колледжа.
const tenantPools = new Map();
function tenantPool(dbName) {
    const name = dbName || DEFAULT_DB_NAME;
    if (!tenantPools.has(name)) {
        tenantPools.set(name, mysql2.createPool({ ...baseDbConfig, database: name }));
    }
    return tenantPools.get(name);
}
// БД по умолчанию тоже регистрируем в кэше под её именем.
tenantPools.set(DEFAULT_DB_NAME, pool);

// Безопасное имя БД (только латиница/цифры/подчёркивание) для интерполяции в DDL.
function safeDbName(name) {
    return String(name).replace(/[^a-zA-Z0-9_]/g, '');
}

async function runSchemaMigration(db, sql, ignoredCodes = []) {
    try {
        await db.query(sql);
    } catch (error) {
        if (ignoredCodes.includes(error.code)) return;
        throw error;
    }
}

// Проверка подключения + авто-создание недостающих таблиц.
// Ошибки не подавляются: HTTP-сервер не должен принимать запросы с неготовой БД.
async function initializeApplication() {
    const conn = await pool.getConnection();
    try {
        await conn.query('SELECT 1');
        console.log(' Подключение к базе данных успешно!');
    } finally {
        conn.release();
    }
    await ensureSchema(pool);
    await ensureControlSchema();
    await syncTenantSchemas();
}

// Накатывает схему на ВСЕ активные колледжи при старте (на случай дрейфа схемы).
async function syncTenantSchemas() {
    if (!controlPool) return;
    const [tenants] = await controlPool.execute(
        'SELECT db_name FROM tenants WHERE is_active = TRUE'
    );
    await Promise.all(tenants.map(t => ensureTenantSchema(tenantPool(t.db_name))));
    console.log(` Схемы колледжей синхронизированы (${tenants.length}).`);
}

// Создаёт control-БД (реестр колледжей и супер-админов) и наполняет значениями по умолчанию.
async function ensureControlSchema() {
    const cName = safeDbName(CONTROL_DB_NAME);
    if (!cName) throw new Error('CONTROL_DB_NAME содержит недопустимое имя БД');
    await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${cName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    controlPool = mysql2.createPool({ ...baseDbConfig, database: cName });

    await controlPool.query(`
            CREATE TABLE IF NOT EXISTS tenants (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(60) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                db_name VARCHAR(120) NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
    await controlPool.query(`
            CREATE TABLE IF NOT EXISTS platform_admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                token_version INT NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
    await runSchemaMigration(
        controlPool,
        'ALTER TABLE platform_admins ADD COLUMN token_version INT NOT NULL DEFAULT 0',
        ['ER_DUP_FIELDNAME']
    );
    await runSchemaMigration(
        controlPool,
        'ALTER TABLE platform_admins ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE',
        ['ER_DUP_FIELDNAME']
    );

    // Колледж по умолчанию = текущая БД (чтобы существующий вход работал).
    const [tenants] = await controlPool.execute('SELECT COUNT(*) AS n FROM tenants');
    if (tenants[0].n === 0) {
        await controlPool.execute(
            'INSERT INTO tenants (code, name, db_name) VALUES (?, ?, ?)',
            ['default', 'Колледж по умолчанию', DEFAULT_DB_NAME]
        );
    }

    // Супер-админ (владелец SaaS). Пароль никогда не имеет значения по умолчанию.
    const [admins] = await controlPool.execute('SELECT COUNT(*) AS n FROM platform_admins');
    if (admins[0].n === 0) {
        const suUser = String(process.env.SUPERADMIN_USER || 'superadmin').trim();
        const suPass = SUPERADMIN_PASSWORD;
        if (suPass.length < 12) {
            throw new Error('Для первого запуска задайте SUPERADMIN_PASSWORD длиной не менее 12 символов');
        }
        const hash = await bcrypt.hash(suPass, 12);
        await controlPool.execute(
            'INSERT INTO platform_admins (username, password, full_name) VALUES (?, ?, ?)',
            [suUser, hash, 'Супер-администратор']
        );
        console.log(` Супер-администратор «${suUser}» создан. Пароль в журнал не выводится.`);
    }
    console.log(' Control-БД готова (мультиарендность).');
}

// Резолвинг колледжа по коду -> запись tenant | null
async function getTenantByCode(code) {
    if (!controlPool) return null;
    const c = String(code || '').trim() || 'default';
    const [rows] = await controlPool.execute(
        'SELECT * FROM tenants WHERE code = ? AND is_active = TRUE',
        [c]
    );
    return rows[0] || null;
}

// Создаёт таблицы, которых может не быть в БД колледжа (без ручной миграции).
// db — пул БД колледжа (по умолчанию — основная).
async function ensureSchema(db) {
    const target = db || pool;
    await target.execute(`
            CREATE TABLE IF NOT EXISTS methodologies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                meth_key VARCHAR(100) UNIQUE,
                title VARCHAR(255) NOT NULL,
                data JSON NOT NULL,
                created_by INT,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
}

// Полная схема БД колледжа (все таблицы IF NOT EXISTS). Используется при
// провижининге нового колледжа и при старте для авто-миграции существующих.
// Индексы заданы инлайн в CREATE TABLE, чтобы повторный запуск не падал.
async function ensureTenantSchema(db) {
    const stmts = [
        `CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            full_name VARCHAR(255) NOT NULL,
            role ENUM('admin','curator','student') NOT NULL DEFAULT 'student',
            birth_date DATE,
            group_name VARCHAR(100),
            email VARCHAR(150),
            phone VARCHAR(20),
            token_version INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            is_active BOOLEAN DEFAULT TRUE,
            KEY idx_users_role (role),
            KEY idx_users_group (group_name)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS student_profiles (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNIQUE NOT NULL,
            family_type ENUM('full','single_parent','guardian','other') NOT NULL,
            lives_with TEXT,
            school VARCHAR(255),
            home_address VARCHAR(500),
            psychologist_notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS questionnaires (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            created_by INT NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            target_groups JSON,
            methodology_data JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS questions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            questionnaire_id INT NOT NULL,
            question_text TEXT NOT NULL,
            question_type ENUM('single','multiple','scale','text') NOT NULL,
            options JSON,
            scale_min INT DEFAULT 1,
            scale_max INT DEFAULT 5,
            scale_labels JSON,
            is_required BOOLEAN DEFAULT TRUE,
            order_index INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS results (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            questionnaire_id INT NOT NULL,
            assignment_id INT NULL,
            answers JSON NOT NULL,
            score DECIMAL(10,2),
            status ENUM('in_progress','completed') DEFAULT 'in_progress',
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
            KEY idx_results_user (user_id),
            KEY idx_results_questionnaire (questionnaire_id),
            UNIQUE KEY uq_results_assignment (assignment_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS assignments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            questionnaire_id INT NOT NULL,
            user_id INT NOT NULL,
            assigned_by INT NOT NULL,
            due_date DATE,
            status ENUM('assigned','started','completed','expired') DEFAULT 'assigned',
            assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (assigned_by) REFERENCES users(id),
            KEY idx_assignments_user (user_id, status)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS methodologies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            meth_key VARCHAR(100) UNIQUE,
            title VARCHAR(255) NOT NULL,
            data JSON NOT NULL,
            created_by INT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS audit_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT,
            action VARCHAR(100) NOT NULL,
            entity_type VARCHAR(50),
            entity_id INT,
            details JSON,
            ip_address VARCHAR(45),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS anonymous_campaigns (
            id INT AUTO_INCREMENT PRIMARY KEY,
            survey_key VARCHAR(80) NOT NULL,
            title VARCHAR(255) NOT NULL,
            survey_data JSON NOT NULL,
            target_group VARCHAR(100),
            access_token CHAR(64) UNIQUE NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            closes_at DATETIME NULL,
            created_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
            KEY idx_anonymous_campaigns_active (is_active, closes_at)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS anonymous_responses (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            campaign_id INT NOT NULL,
            answers JSON NOT NULL,
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (campaign_id) REFERENCES anonymous_campaigns(id) ON DELETE CASCADE,
            KEY idx_anonymous_responses_campaign (campaign_id, submitted_at)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        `CREATE TABLE IF NOT EXISTS ai_analyses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            scope ENUM('result','student','group') NOT NULL,
            target_id VARCHAR(120) NOT NULL,
            model VARCHAR(120),
            source_count INT NOT NULL DEFAULT 1,
            content MEDIUMTEXT NOT NULL,
            created_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_ai_scope_target (scope, target_id),
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    ];
    for (const sql of stmts) {
        await db.query(sql);
    }
    // Идемпотентные миграции существующих БД колледжей.
    await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','curator','student') NOT NULL DEFAULT 'student'");
    await runSchemaMigration(
        db,
        'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER phone',
        ['ER_DUP_FIELDNAME']
    );
    await runSchemaMigration(
        db,
        'ALTER TABLE questionnaires ADD COLUMN methodology_data JSON NULL AFTER target_groups',
        ['ER_DUP_FIELDNAME']
    );
    await runSchemaMigration(
        db,
        'ALTER TABLE results ADD COLUMN assignment_id INT NULL AFTER questionnaire_id',
        ['ER_DUP_FIELDNAME']
    );
    await runSchemaMigration(
        db,
        'ALTER TABLE results ADD UNIQUE KEY uq_results_assignment (assignment_id)',
        ['ER_DUP_KEYNAME']
    );
    await runSchemaMigration(
        db,
        `ALTER TABLE results
         ADD CONSTRAINT fk_results_assignment
         FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE`,
        ['ER_FK_DUP_NAME', 'ER_DUP_KEYNAME']
    );
}
// ============================================
// АУТЕНТИФИКАЦИЯ И MIDDLEWARE
// ============================================

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();

function loginAttemptKey(req) {
    return String(req.ip || req.socket.remoteAddress || 'unknown');
}

function loginRateLimit(req, res, next) {
    const key = loginAttemptKey(req);
    const now = Date.now();
    const state = loginFailures.get(key);
    if (state && state.resetAt > now && state.count >= LOGIN_MAX_FAILURES) {
        const retryAfter = Math.ceil((state.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Слишком много попыток входа. Повторите позже.' });
    }
    if (state && state.resetAt <= now) loginFailures.delete(key);
    req.loginAttemptKey = key;
    next();
}

function recordLoginFailure(req) {
    const key = req.loginAttemptKey || loginAttemptKey(req);
    const now = Date.now();
    const state = loginFailures.get(key);
    if (!state || state.resetAt <= now) {
        loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
        state.count += 1;
    }
    if (loginFailures.size > 5000) {
        for (const [entryKey, entry] of loginFailures) {
            if (entry.resetAt <= now) loginFailures.delete(entryKey);
        }
    }
}

function clearLoginFailures(req) {
    loginFailures.delete(req.loginAttemptKey || loginAttemptKey(req));
}

// Middleware проверки JWT токена
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const [scheme, token] = String(authHeader || '').split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    let claims;
    try {
        claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (_) {
        return res.status(403).json({ error: 'Недействительный токен' });
    }

    try {
        if (claims.accountType === 'platform') {
            if (!controlPool) return res.status(503).json({ error: 'Control-БД недоступна' });
            const [[admin]] = await controlPool.execute(
                `SELECT id, username, full_name, token_version
                 FROM platform_admins WHERE id = ? AND is_active = TRUE`,
                [claims.sub]
            );
            if (!admin || Number(claims.tokenVersion) !== Number(admin.token_version)) {
                return res.status(403).json({ error: 'Сессия завершена. Войдите снова.' });
            }
            req.user = {
                id: admin.id,
                username: admin.username,
                fullName: admin.full_name,
                role: 'super_admin'
            };
            req.db = null;
            return next();
        }

        if (claims.accountType !== 'tenant' || !claims.tenantCode) {
            return res.status(403).json({ error: 'Недействительный токен' });
        }

        // БД, роль и группа никогда не берутся из JWT: они перепроверяются на каждом запросе.
        const tenant = await getTenantByCode(claims.tenantCode);
        if (!tenant) {
            return res.status(403).json({ error: 'Колледж отключён или не найден' });
        }
        const db = tenantPool(tenant.db_name);
        const [[user]] = await db.execute(
            `SELECT id, username, full_name, role, group_name, token_version
             FROM users WHERE id = ? AND is_active = TRUE`,
            [claims.sub]
        );
        if (!user || Number(claims.tokenVersion) !== Number(user.token_version)) {
            return res.status(403).json({ error: 'Сессия завершена. Войдите снова.' });
        }

        req.user = {
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            role: user.role,
            group: user.group_name,
            tenantCode: tenant.code
        };
        req.tenant = tenant;
        req.db = db;
        next();
    } catch (error) {
        console.error('Ошибка проверки сессии:', error.message);
        res.status(500).json({ error: 'Ошибка проверки сессии' });
    }
}

// Middleware проверки роли администратора
function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён. Требуются права администратора.' });
    }
    next();
}

// Middleware проверки супер-админа (владелец SaaS)
function requireSuperAdmin(req, res, next) {
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Доступ запрещён. Требуются права супер-администратора.' });
    }
    next();
}

// Middleware: персонал колледжа (психолог-админ или куратор) — для чтения.
function requireStaff(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'curator') {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }
    next();
}

function requireStudent(req, res, next) {
    if (req.user.role !== 'student') {
        return res.status(403).json({ error: 'Доступ разрешён только студентам' });
    }
    next();
}

// Логирование действий (db — пул БД колледжа)
async function logAction(db, userId, action, entityType, entityId, details = null, ipAddress = null) {
    try {
        await db.execute(
            'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, action, entityType, entityId, details != null ? JSON.stringify(details) : null, ipAddress]
        );
    } catch (e) { /* игнорируем ошибки логирования */ }
}

function normalizeSelectedUserIds(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
    const ids = [...new Set(value.map(Number))];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return null;
    return ids;
}

async function bulkUpdateUsers(db, {
    userIds,
    action,
    newPassword,
    allowedRoles = ['admin', 'curator', 'student'],
    protectLastAdmin = false
}) {
    const ids = normalizeSelectedUserIds(userIds);
    if (!ids) {
        const error = new Error('Выберите от 1 до 200 пользователей');
        error.statusCode = 400;
        throw error;
    }
    if (!['reset_password', 'activate', 'deactivate'].includes(action)) {
        const error = new Error('Неизвестная операция');
        error.statusCode = 400;
        throw error;
    }
    if (action === 'reset_password' && String(newPassword || '').length < 8) {
        const error = new Error('Пароль должен быть не короче 8 символов');
        error.statusCode = 400;
        throw error;
    }

    const placeholders = ids.map(() => '?').join(',');
    const rolePlaceholders = allowedRoles.map(() => '?').join(',');
    const [targets] = await db.execute(
        `SELECT id, username, role, is_active
         FROM users
         WHERE id IN (${placeholders}) AND role IN (${rolePlaceholders})`,
        [...ids, ...allowedRoles]
    );
    if (targets.length !== ids.length) {
        const error = new Error('Один или несколько пользователей не найдены или недоступны');
        error.statusCode = 404;
        throw error;
    }

    if (protectLastAdmin && action === 'deactivate' &&
        targets.some(target => target.role === 'admin' && Boolean(target.is_active))) {
        const [[remaining]] = await db.execute(
            `SELECT COUNT(*) AS n
             FROM users
             WHERE role = 'admin' AND is_active = TRUE AND id NOT IN (${placeholders})`,
            ids
        );
        if (Number(remaining.n) === 0) {
            const error = new Error('Нельзя отключить последнего активного психолога колледжа');
            error.statusCode = 400;
            throw error;
        }
    }

    if (action === 'reset_password') {
        const hash = await bcrypt.hash(String(newPassword), 10);
        await db.execute(
            `UPDATE users
             SET password = ?, token_version = token_version + 1
             WHERE id IN (${placeholders})`,
            [hash, ...ids]
        );
    } else {
        await db.execute(
            `UPDATE users
             SET is_active = ?, token_version = token_version + 1
             WHERE id IN (${placeholders})`,
            [action === 'activate' ? 1 : 0, ...ids]
        );
    }

    return { ids, targets };
}

function parseJsonValue(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function optionText(option) {
    return option && typeof option === 'object' ? option.text : option;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findAnonymousSurvey(key) {
    return PSY_ANONYMOUS_SURVEYS.find(survey => survey.id === key) || null;
}

function validateAnonymousAnswers(survey, answers) {
    if (!isPlainObject(answers)) return 'Ответы должны быть объектом';
    const knownIds = new Set(survey.questions.map(question => question.id));
    if (Object.keys(answers).some(key => !knownIds.has(key))) {
        return 'Ответы содержат неизвестный вопрос';
    }
    for (const question of survey.questions) {
        const value = answers[question.id];
        if (!isAnonymousQuestionVisible(question, answers)) continue;
        if (question.required !== false && value == null) {
            return `Ответьте на вопрос «${question.text}»`;
        }
        if (value != null && !question.options.includes(value)) {
            return `Недопустимый ответ на вопрос «${question.text}»`;
        }
    }
    return null;
}

function validateQuestionnaireAnswers(questions, answers) {
    if (!isPlainObject(answers)) {
        return 'Ответы должны быть объектом';
    }

    for (let idx = 0; idx < questions.length; idx++) {
        const question = questions[idx];
        const answer = answers[idx];
        const isEmpty = answer == null ||
            (typeof answer === 'string' && answer.trim() === '') ||
            (Array.isArray(answer) && answer.length === 0);

        if (question.is_required && isEmpty) {
            return `Ответьте на обязательный вопрос №${idx + 1}`;
        }
        if (isEmpty) continue;

        const options = parseJsonValue(question.options, []);
        const allowed = Array.isArray(options) ? options.map(optionText) : [];

        if (question.question_type === 'single') {
            if (typeof answer !== 'string' || !allowed.includes(answer)) {
                return `Недопустимый ответ на вопрос №${idx + 1}`;
            }
        } else if (question.question_type === 'multiple') {
            if (!Array.isArray(answer) ||
                new Set(answer).size !== answer.length ||
                answer.some(item => typeof item !== 'string' || !allowed.includes(item))) {
                return `Недопустимый ответ на вопрос №${idx + 1}`;
            }
        } else if (question.question_type === 'scale') {
            const numeric = Number(answer);
            if (!Number.isFinite(numeric) || numeric < question.scale_min || numeric > question.scale_max) {
                return `Значение шкалы вне диапазона в вопросе №${idx + 1}`;
            }
        } else if (question.question_type === 'text') {
            if (typeof answer !== 'string' || answer.length > 10000) {
                return `Недопустимый текстовый ответ на вопрос №${idx + 1}`;
            }
        }
    }
    return null;
}

function fallbackQuestionnaireScore(questions, answers) {
    const hasWeights = questions.some(question => {
        const options = parseJsonValue(question.options, []);
        return Array.isArray(options) && options.some(
            option => option && typeof option === 'object' && typeof option.score === 'number'
        );
    });

    if (hasWeights) {
        let sum = 0;
        questions.forEach((question, idx) => {
            const selected = Array.isArray(answers[idx]) ? answers[idx] : [answers[idx]];
            const options = parseJsonValue(question.options, []);
            selected.forEach(answer => {
                const option = Array.isArray(options)
                    ? options.find(candidate => optionText(candidate) === answer)
                    : null;
                if (option && typeof option === 'object' && typeof option.score === 'number') {
                    sum += option.score;
                }
            });
        });
        return sum;
    }

    const scaleAnswers = questions
        .map((question, idx) => question.question_type === 'scale' ? Number(answers[idx]) : null)
        .filter(value => Number.isFinite(value));
    return scaleAnswers.length
        ? Number((scaleAnswers.reduce((sum, value) => sum + value, 0) / scaleAnswers.length).toFixed(2))
        : 0;
}

function deriveResultMetadata(result) {
    const answers = parseJsonValue(result && result.answers, {});
    const snapshot = parseJsonValue(result && result.methodology_data, null);
    const methodology = snapshot || findMethodologyByTitle(result && result.questionnaire_title);

    if (!methodology) {
        return {
            ...result,
            answers,
            interpretation_level: null,
            interpretation_label: null,
            at_risk: false,
            risk_reasons: []
        };
    }

    const scored = scoreMethodology(methodology, answers);
    const primary = scored.primary && scored.primary.interp;
    const riskReasons = scored.scales
        .filter(scale => scale.interp && scale.interp.attention)
        .map(scale => ({ scale: scale.name, label: scale.interp.label }));

    return {
        ...result,
        answers,
        interpretation_level: primary ? primary.level : null,
        interpretation_label: primary ? primary.label : null,
        at_risk: riskReasons.length > 0,
        risk_reasons: riskReasons
    };
}

async function resolveMethodologyForQuestionnaire(db, questionnaire) {
    const snapshot = parseJsonValue(questionnaire.methodology_data, null);
    if (snapshot && typeof snapshot === 'object') return snapshot;

    const builtin = findMethodologyByTitle(questionnaire.title);
    if (builtin) return builtin;

    const [rows] = await db.execute(
        'SELECT data FROM methodologies WHERE title = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1',
        [questionnaire.title]
    );
    return rows.length ? parseJsonValue(rows[0].data, null) : null;
}

// ============================================
// ИИ-АНАЛИЗ РЕЗУЛЬТАТОВ (Open Web UI)
// ============================================

// Вызов OpenAI-совместимого API Open Web UI. Ошибки несут statusCode для ответа клиенту.
async function callLlm(messages) {
    if (!AI_ANALYSIS_ENABLED) {
        const error = new Error('ИИ-анализ не настроен. Задайте OPENWEBUI_BASE_URL, OPENWEBUI_API_KEY и OPENWEBUI_MODEL.');
        error.statusCode = 503;
        throw error;
    }
    let response;
    try {
        response = await fetch(`${OPENWEBUI_BASE_URL}/api/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENWEBUI_API_KEY}`
            },
            body: JSON.stringify({ model: OPENWEBUI_MODEL, messages, stream: false, temperature: 0.3 }),
            signal: AbortSignal.timeout(OPENWEBUI_TIMEOUT_MS)
        });
    } catch (cause) {
        const isTimeout = cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        const error = new Error(isTimeout ? 'ИИ-сервис не ответил вовремя' : 'ИИ-сервис недоступен');
        error.statusCode = isTimeout ? 504 : 502;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`Ошибка ИИ-сервиса (HTTP ${response.status})`);
        error.statusCode = 502;
        throw error;
    }
    const data = await response.json().catch(() => null);
    const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || '').trim()
        : '';
    if (!content) {
        const error = new Error('ИИ-сервис вернул пустой ответ');
        error.statusCode = 502;
        throw error;
    }
    return content;
}

// Обезличенная сводка одного результата для промпта.
// Никогда не включает ФИО/логин/контакты студента.
function buildScoredSummary(row) {
    const answers = parseJsonValue(row.answers, {});
    const methodology = parseJsonValue(row.methodology_data, null)
        || findMethodologyByTitle(row.questionnaire_title);
    const base = {
        test: row.questionnaire_title,
        completed_at: row.completed_at ? new Date(row.completed_at).toISOString().slice(0, 10) : null
    };
    if (!methodology) {
        return { ...base, score: row.score != null ? Number(row.score) : null, scales: null };
    }
    const scored = scoreMethodology(methodology, answers);
    return {
        ...base,
        scales: scored.scales
            .filter(scale => scale.display !== false)
            .map(scale => ({
                name: scale.name,
                raw: scale.raw,
                max: scale.maxScore != null ? scale.maxScore : null,
                level: scale.interp ? scale.interp.level : null,
                label: scale.interp ? scale.interp.label : null,
                attention: Boolean(scale.interp && scale.interp.attention)
            })),
        validity_warnings: (scored.validity || [])
            .filter(check => check.failed)
            .map(check => check.warning || check.name)
    };
}

function studentAgeFromBirthDate(birthDate) {
    if (!birthDate) return null;
    const born = new Date(birthDate);
    if (Number.isNaN(born.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - born.getFullYear();
    if (now.getMonth() < born.getMonth() ||
        (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())) age--;
    return age >= 0 && age < 120 ? age : null;
}

const AI_PROMPT_COMMON = `Ты — ассистент педагога-психолога колледжа. Тебе передают ОБЕЗЛИЧЕННЫЕ результаты стандартизированных психологических методик (названия шкал, баллы, уровни, отметки зон внимания).
Правила:
- Пиши по-русски, структурированно: краткое резюме; интерпретация по шкалам; зоны внимания и риска; практические рекомендации психологу.
- Опирайся ТОЛЬКО на переданные данные. Не выдумывай факты и не запрашивай личные данные студентов.
- Если есть предупреждения шкал достоверности — обязательно оговори ограничения выводов.
- В конце обязательно укажи: это автоматический вспомогательный анализ, НЕ диагноз; окончательные выводы делает специалист.
- Не используй markdown-таблицы; пиши короткими абзацами и списками, начиная пункты с "-".`;

function buildResultPrompt(summary, meta) {
    const system = `${AI_PROMPT_COMMON}\nЗадача: проинтерпретируй результат одного прохождения теста студентом.`;
    const payload = {
        student: { group: meta && meta.group || null, age: meta && meta.age != null ? meta.age : null },
        result: summary
    };
    return [
        { role: 'system', content: system },
        { role: 'user', content: `Данные результата:\n${JSON.stringify(payload, null, 1)}` }
    ];
}

function buildStudentPrompt(meta, summaries) {
    const system = `${AI_PROMPT_COMMON}\nЗадача: составь целостный психологический портрет студента по всем его результатам. При повторных прохождениях одного теста отметь динамику.`;
    const payload = {
        student: { group: meta && meta.group || null, age: meta && meta.age != null ? meta.age : null },
        results: summaries
    };
    return [
        { role: 'system', content: system },
        { role: 'user', content: `Все результаты студента (по датам):\n${JSON.stringify(payload, null, 1)}` }
    ];
}

const AI_GROUP_STUDENT_LIMIT = 50;

function buildGroupPrompt(groupName, students) {
    const system = `${AI_PROMPT_COMMON}\nЗадача: выяви групповые тенденции и зоны риска по группе. Студенты пронумерованы условно ("Студент 1", "Студент 2", ...) — НЕ делай персональных выводов, только групповые.`;
    const limited = students.slice(0, AI_GROUP_STUDENT_LIMIT);
    let atRiskCount = 0;
    const levelDistribution = {};
    const anonymized = limited.map((student, index) => {
        let atRisk = false;
        (student.results || []).forEach(summary => {
            (summary.scales || []).forEach(scale => {
                if (scale.attention) atRisk = true;
                if (scale.level) {
                    const key = `${summary.test} / ${scale.name}`;
                    if (!levelDistribution[key]) levelDistribution[key] = {};
                    levelDistribution[key][scale.level] = (levelDistribution[key][scale.level] || 0) + 1;
                }
            });
        });
        if (atRisk) atRiskCount++;
        return {
            label: `Студент ${index + 1}`,
            age: student.age != null ? student.age : null,
            results: student.results
        };
    });
    const payload = {
        group: groupName,
        aggregates: {
            tested_students: limited.length,
            at_risk_count: atRiskCount,
            level_distribution: levelDistribution,
            truncated: students.length > AI_GROUP_STUDENT_LIMIT
                ? `Показаны первые ${AI_GROUP_STUDENT_LIMIT} из ${students.length} студентов`
                : undefined
        },
        students: anonymized
    };
    return [
        { role: 'system', content: system },
        { role: 'user', content: `Данные группы:\n${JSON.stringify(payload, null, 1)}` }
    ];
}

// ============================================
// API РОУТЫ - АУТЕНТИФИКАЦИЯ
// ============================================

// Вход в систему
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
    try {
        const { username, password, college } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Укажите логин и пароль' });
        }

        // Вход супер-админа (владелец SaaS): код колледжа = "platform".
        if (String(college || '').trim().toLowerCase() === 'platform') {
            if (!controlPool) return res.status(503).json({ error: 'Control-БД недоступна' });
            const [admins] = await controlPool.execute(
                'SELECT * FROM platform_admins WHERE username = ? AND is_active = TRUE', [username]
            );
            if (admins.length === 0 || !(await bcrypt.compare(password, admins[0].password))) {
                recordLoginFailure(req);
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }
            const sa = admins[0];
            const token = jwt.sign(
                { sub: sa.id, accountType: 'platform', tokenVersion: sa.token_version },
                JWT_SECRET, { algorithm: 'HS256', expiresIn: '8h' }
            );
            clearLoginFailures(req);
            return res.json({
                token,
                user: { id: sa.id, username: sa.username, fullName: sa.full_name, role: 'super_admin' }
            });
        }

        // Вход в конкретный колледж (пустой код → колледж по умолчанию).
        const tenant = await getTenantByCode(college);
        if (!tenant) {
            recordLoginFailure(req);
            return res.status(401).json({ error: 'Неверный логин, пароль или код колледжа' });
        }
        const db = tenantPool(tenant.db_name);

        const [users] = await db.execute(
            'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
            [username]
        );

        if (users.length === 0) {
            recordLoginFailure(req);
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            recordLoginFailure(req);
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const token = jwt.sign(
            {
                sub: user.id,
                accountType: 'tenant',
                tenantCode: tenant.code,
                tokenVersion: user.token_version
            },
            JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '8h' }
        );

        clearLoginFailures(req);
        await logAction(db, user.id, 'LOGIN', 'user', user.id, { success: true });

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                fullName: user.full_name,
                role: user.role,
                groupName: user.group_name,
                birthDate: user.birth_date,
                tenantCode: tenant.code
            }
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получение текущего пользователя
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        if (req.user.role === 'super_admin') {
            return res.json({
                id: req.user.id,
                username: req.user.username,
                full_name: req.user.fullName,
                role: req.user.role
            });
        }
        const [users] = await req.db.execute(
            'SELECT id, username, full_name, role, birth_date, group_name, email, phone, created_at FROM users WHERE id = ?',
            [req.user.id]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const user = users[0];
        
        // Вычисляем возраст
        let age = null;
        if (user.birth_date) {
            const birthDate = new Date(user.birth_date);
            const today = new Date();
            age = today.getFullYear() - birthDate.getFullYear();
            const monthDiff = today.getMonth() - birthDate.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
                age--;
            }
        }
        
        res.json({
            ...user,
            age,
            isAdult: age === null || age >= 18
        });
    } catch (error) {
        console.error('Ошибка получения пользователя:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================
// API РОУТЫ - СТУДЕНТЫ (для админа)
// ============================================

// Получение списка всех студентов
app.get('/api/students', authenticateToken, requireStaff, async (req, res) => {
    try {
        const { search } = req.query;
        // Куратор видит только свою группу; админ — все (или по фильтру).
        const group = req.user.role === 'curator' ? req.user.group : req.query.group;
        let query = `
            SELECT u.id, u.username, u.full_name, u.birth_date, u.group_name,
                   u.email, u.phone, u.created_at,
                   sp.family_type, sp.lives_with, sp.school, sp.home_address
            FROM users u
            LEFT JOIN student_profiles sp ON u.id = sp.user_id
            WHERE u.role = 'student' AND u.is_active = TRUE
        `;
        const params = [];

        if (req.user.role === 'curator' && !group) {
            // Куратор без назначенной группы не видит студентов.
            return res.json([]);
        }
        if (group) {
            query += ' AND u.group_name = ?';
            params.push(group);
        }

        if (search) {
            query += ' AND (u.full_name LIKE ? OR u.username LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        if (req.query.studentId) {
            query += ' AND u.id = ?';
            params.push(parseInt(req.query.studentId));
        }
        
        query += ' ORDER BY u.group_name, u.full_name';
        
        const [students] = await req.db.execute(query, params);
        
        // Добавляем возраст каждому студенту
        const studentsWithAge = students.map(s => ({
            ...s,
            age: s.birth_date ? Math.floor((new Date() - new Date(s.birth_date)) / (365.25 * 24 * 60 * 60 * 1000)) : null
        }));
        
        res.json(studentsWithAge);
    } catch (error) {
        console.error('Ошибка получения студентов:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Создание студента
app.post('/api/students', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const {
            username, password, full_name, birth_date,
            group_name, email, phone,
            family_type, lives_with, school, home_address
        } = req.body;
        const effectivePassword = String(password || DEFAULT_STUDENT_PASSWORD).trim();

        if (!username || !effectivePassword || !full_name || !birth_date) {
            return res.status(400).json({ error: 'Заполните обязательные поля' });
        }
        if (effectivePassword.length < 8) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
        }

        const hashedPassword = await bcrypt.hash(effectivePassword, 10);

        const conn = await req.db.getConnection();
        await conn.beginTransaction();
        
        try {
            const [result] = await conn.execute(
                `INSERT INTO users (username, password, full_name, role, birth_date, group_name, email, phone)
                VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`,
                [username, hashedPassword, full_name, birth_date, group_name || null, email || null, phone || null]
            );
            
            const userId = result.insertId;
            
            await conn.execute(
                `INSERT INTO student_profiles (user_id, family_type, lives_with, school, home_address)
                 VALUES (?, ?, ?, ?, ?)`,
                [userId, family_type || 'full', lives_with || '', school || null, home_address || null]
            );
            
            await logAction(conn, req.user.id, 'CREATE_STUDENT', 'user', userId, { fullName: full_name });
            
            await conn.commit();
            res.status(201).json({ message: 'Студент создан успешно', userId });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Ошибка создания студента:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
        }
        res.status(500).json({ error: 'Ошибка создания студента' });
    }
});

// Обновление данных студента
app.put('/api/students/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        
        const conn = await req.db.getConnection();
        await conn.beginTransaction();
        
        try {
            // Обновляем основную информацию
            const [userUpdate] = await conn.execute(
                `UPDATE users SET full_name = ?, birth_date = ?, group_name = ?,
                 email = ?, phone = ?, updated_at = NOW()
                 WHERE id = ? AND role = 'student'`,
                [data.full_name, data.birth_date, data.group_name,
                 data.email, data.phone, id]
            );
            if (userUpdate.affectedRows === 0) {
                const notFound = new Error('Студент не найден');
                notFound.statusCode = 404;
                throw notFound;
            }
            
            // Обновляем профиль
            await conn.execute(
                `UPDATE student_profiles SET family_type = ?, lives_with = ?, 
                 school = ?, home_address = ?, updated_at = NOW()
                 WHERE user_id = ?`,
                [data.family_type, data.lives_with, data.school, data.home_address, id]
            );
            
            await logAction(conn, req.user.id, 'UPDATE_STUDENT', 'user', parseInt(id), data);
            
            await conn.commit();
            res.json({ message: 'Данные обновлены' });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Ошибка обновления студента:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Ошибка обновления' });
    }
});

// Удаление студента (мягкое)
app.delete('/api/students/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [result] = await req.db.execute(
            "UPDATE users SET is_active = FALSE, token_version = token_version + 1 WHERE id = ? AND role = 'student'",
            [req.params.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Студент не найден' });
        }
        await logAction(req.db, req.user.id, 'DELETE_STUDENT', 'user', parseInt(req.params.id));
        res.json({ message: 'Студент деактивирован' });
    } catch (error) {
        console.error('Ошибка удаления:', error);
        res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// Сброс пароля студента админом (только в рамках своего колледжа — req.db).
app.post('/api/students/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { newPassword } = req.body || {};
        if (!newPassword || String(newPassword).length < 8) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
        }
        const [[student]] = await req.db.execute(
            "SELECT id, username FROM users WHERE id = ? AND role = 'student'",
            [req.params.id]
        );
        if (!student) {
            return res.status(404).json({ error: 'Студент не найден' });
        }
        const hash = await bcrypt.hash(newPassword, 10);
        await req.db.execute(
            'UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?',
            [hash, req.params.id]
        );
        await logAction(req.db, req.user.id, 'RESET_STUDENT_PASSWORD', 'user', parseInt(req.params.id), { username: student.username });
        res.json({ message: 'Пароль студента изменён' });
    } catch (error) {
        console.error('Ошибка сброса пароля студента:', error);
        res.status(500).json({ error: 'Ошибка сброса пароля' });
    }
});

// Выборочные операции администратора колледжа со студентами и кураторами.
// Администраторы исключены из области действия, чтобы психолог не мог менять чужую учётную запись.
app.post('/api/users/bulk', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { userIds, action, newPassword } = req.body || {};
        const result = await bulkUpdateUsers(req.db, {
            userIds,
            action,
            newPassword,
            allowedRoles: ['student', 'curator']
        });
        await logAction(req.db, req.user.id, `BULK_USER_${String(action).toUpperCase()}`, 'user', null, {
            userIds: result.ids,
            users: result.targets.map(target => target.username)
        });
        const actionLabel = action === 'reset_password'
            ? 'Пароли изменены'
            : action === 'activate'
                ? 'Пользователи включены'
                : 'Пользователи отключены';
        res.json({ message: `${actionLabel}: ${result.ids.length}`, affected: result.ids.length });
    } catch (error) {
        console.error('Ошибка выборочной операции с пользователями:', error);
        res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'Ошибка операции с пользователями'
        });
    }
});

// Массовый импорт студентов (данные парсятся из Excel на клиенте и приходят массивом)
app.post('/api/students/import', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { students } = req.body;
        if (!Array.isArray(students) || students.length === 0) {
            return res.status(400).json({ error: 'Нет данных для импорта' });
        }

        const VALID_FAMILY = ['full', 'single_parent', 'guardian', 'other'];
        let created = 0;
        const errors = [];
        const generatedCredentials = [];

        for (let i = 0; i < students.length; i++) {
            const s = students[i] || {};
            const rowNum = i + 2; // строка в Excel (с учётом заголовка)
            const username = String(s.username || '').trim();

            if (!username) {
                errors.push(`Строка ${rowNum}: не указан логин`);
                continue;
            }

            const fullName = String(s.full_name || '').trim() || username;
            const suppliedPassword = String(s.password || '').trim();
            const password = suppliedPassword || DEFAULT_STUDENT_PASSWORD ||
                `${crypto.randomBytes(9).toString('base64url')}Aa1!`;
            if (suppliedPassword && suppliedPassword.length < 8) {
                errors.push(`Строка ${rowNum}: пароль короче 8 символов`);
                continue;
            }
            let familyType = String(s.family_type || 'full').trim();
            if (!VALID_FAMILY.includes(familyType)) familyType = 'full';
            const birthDate = s.birth_date ? String(s.birth_date).slice(0, 10) : null;

            const conn = await req.db.getConnection();
            try {
                await conn.beginTransaction();
                const hashedPassword = await bcrypt.hash(password, 10);

                const [result] = await conn.execute(
                    `INSERT INTO users (username, password, full_name, role, birth_date, group_name, email, phone)
                     VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`,
                    [username, hashedPassword, fullName, birthDate,
                     s.group_name || null, s.email || null, s.phone || null]
                );
                const userId = result.insertId;

                await conn.execute(
                    `INSERT INTO student_profiles (user_id, family_type, lives_with, school, home_address)
                     VALUES (?, ?, ?, ?, ?)`,
                    [userId, familyType, s.lives_with || '', s.school || null, s.home_address || null]
                );

                await conn.commit();
                created++;
                if (!suppliedPassword) generatedCredentials.push({ username, password });
            } catch (e) {
                await conn.rollback();
                if (e.code === 'ER_DUP_ENTRY') {
                    errors.push(`Строка ${rowNum}: логин «${username}» уже существует`);
                } else {
                    errors.push(`Строка ${rowNum}: ошибка (${e.code || e.message})`);
                }
            } finally {
                conn.release();
            }
        }

        await logAction(req.db, req.user.id, 'IMPORT_STUDENTS', 'user', null, { created, errors: errors.length });
        res.json({ created, total: students.length, errors, generatedCredentials });
    } catch (error) {
        console.error('Ошибка импорта студентов:', error);
        res.status(500).json({ error: 'Ошибка импорта' });
    }
});

// ============================================
// API РОУТЫ - КУРАТОРЫ (для админа-психолога колледжа)
// ============================================

// Список кураторов колледжа
app.get('/api/curators', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [rows] = await req.db.execute(
            "SELECT id, username, full_name, group_name, created_at FROM users WHERE role = 'curator' AND is_active = TRUE ORDER BY full_name"
        );
        res.json(rows);
    } catch (error) {
        console.error('Ошибка списка кураторов:', error);
        res.status(500).json({ error: 'Ошибка загрузки кураторов' });
    }
});

// Создание куратора (read-only по своей группе)
app.post('/api/curators', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { username, password, full_name, group_name } = req.body || {};
        if (!username || !password || !full_name || !group_name) {
            return res.status(400).json({ error: 'Укажите логин, пароль, ФИО и группу' });
        }
        if (String(password).length < 8) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
        }
        const hash = await bcrypt.hash(password, 10);
        const [result] = await req.db.execute(
            "INSERT INTO users (username, password, full_name, role, group_name) VALUES (?, ?, ?, 'curator', ?)",
            [username, hash, full_name, group_name]
        );
        await logAction(req.db, req.user.id, 'CREATE_CURATOR', 'user', result.insertId, { group: group_name });
        res.status(201).json({ message: 'Куратор создан', id: result.insertId });
    } catch (error) {
        console.error('Ошибка создания куратора:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
        }
        res.status(500).json({ error: 'Ошибка создания куратора' });
    }
});

// Удаление куратора (мягкое)
app.delete('/api/curators/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [result] = await req.db.execute(
            "UPDATE users SET is_active = FALSE, token_version = token_version + 1 WHERE id = ? AND role = 'curator'",
            [req.params.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Куратор не найден' });
        }
        await logAction(req.db, req.user.id, 'DELETE_CURATOR', 'user', parseInt(req.params.id));
        res.json({ message: 'Куратор удалён' });
    } catch (error) {
        console.error('Ошибка удаления куратора:', error);
        res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// ============================================
// API РОУТЫ - ПРОФИЛЬ СТУДЕНТА
// ============================================

// Получение своего профиля
app.get('/api/profile', authenticateToken, requireStudent, async (req, res) => {
    try {
        const [profiles] = await req.db.execute(`
            SELECT sp.*, u.full_name, u.birth_date, u.group_name
            FROM student_profiles sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.user_id = ?
        `, [req.user.id]);
        
        if (profiles.length === 0) {
            return res.json(null); // Профиль ещё не заполнен
        }
        
        res.json(profiles[0]);
    } catch (error) {
        console.error('Ошибка профиля:', error);
        res.status(500).json({ error: 'Ошибка загрузки профиля' });
    }
});

// Создание/обновление профиля студента
app.put('/api/profile', authenticateToken, requireStudent, async (req, res) => {
    try {
        const { family_type, lives_with, school, home_address } = req.body;
        if (!['full', 'single_parent', 'guardian', 'other'].includes(family_type)) {
            return res.status(400).json({ error: 'Некорректный тип семьи' });
        }
        if (String(lives_with || '').length > 5000 ||
            String(school || '').length > 255 ||
            String(home_address || '').length > 500) {
            return res.status(400).json({ error: 'Одно из полей превышает допустимую длину' });
        }
        
        // Проверяем существование профиля
        const [existing] = await req.db.execute(
            'SELECT id FROM student_profiles WHERE user_id = ?',
            [req.user.id]
        );
        
        if (existing.length > 0) {
            await req.db.execute(
                `UPDATE student_profiles SET family_type = ?, lives_with = ?, 
                 school = ?, home_address = ?, updated_at = NOW()
                 WHERE user_id = ?`,
                [family_type, lives_with, school || null, home_address || null, req.user.id]
            );
        } else {
            await req.db.execute(
                `INSERT INTO student_profiles (user_id, family_type, lives_with, school, home_address)
                 VALUES (?, ?, ?, ?, ?)`,
                [req.user.id, family_type, lives_with, school || null, home_address || null]
            );
        }
        
        await logAction(req.db, req.user.id, 'UPDATE_PROFILE', 'profile', req.user.id);
        res.json({ message: 'Профиль сохранён' });
    } catch (error) {
        console.error('Ошибка сохранения профиля:', error);
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

// ============================================
// API РОУТЫ - ОПРОСНИКИ/ТЕСТЫ
// ============================================

// Получение всех опросников (для админа)
app.get('/api/questionnaires', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [questionnaires] = await req.db.execute(`
            SELECT q.*, u.full_name as creator_name,
                   (SELECT COUNT(*) FROM questions qu WHERE qu.questionnaire_id = q.id) as questions_count
            FROM questionnaires q
            JOIN users u ON q.created_by = u.id
            ORDER BY q.created_at DESC
        `);
        res.json(questionnaires);
    } catch (error) {
        console.error('Ошибка опросников:', error);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// Создание опросника
app.post('/api/questionnaires', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { title, description, questions, methodology } = req.body;

        if (!String(title || '').trim() || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'Укажите название и вопросы' });
        }
        if (String(title).length > 255 || questions.length > 500) {
            return res.status(400).json({ error: 'Слишком длинное название или слишком много вопросов' });
        }
        const validTypes = new Set(['single', 'multiple', 'scale', 'text']);
        for (const [index, question] of questions.entries()) {
            if (!question || !String(question.questionText || '').trim() || !validTypes.has(question.questionType)) {
                return res.status(400).json({ error: `Некорректный вопрос №${index + 1}` });
            }
        }
        if (methodology && (
            typeof methodology !== 'object' ||
            String(methodology.title || '').trim() !== String(title).trim() ||
            !Array.isArray(methodology.questions) ||
            methodology.questions.length !== questions.length
        )) {
            return res.status(400).json({ error: 'Формула методики не соответствует тесту' });
        }
        if (!methodology) {
            const [namedMethodologies] = await req.db.execute(
                'SELECT id FROM methodologies WHERE title = ? AND is_active = TRUE LIMIT 1',
                [String(title).trim()]
            );
            if (findMethodologyByTitle(title) || namedMethodologies.length) {
                return res.status(400).json({
                    error: 'Название совпадает с методикой. Выберите её из списка, чтобы сохранить формулу.'
                });
            }
        }
        const methodologySnapshot = methodology && typeof methodology === 'object'
            ? JSON.stringify(methodology)
            : null;

        const conn = await req.db.getConnection();
        await conn.beginTransaction();
        
        try {
            const [result] = await conn.execute(
                `INSERT INTO questionnaires (title, description, created_by, methodology_data)
                 VALUES (?, ?, ?, ?)`,
                [String(title).trim(), description || null, req.user.id, methodologySnapshot]
            );
            
            const questionnaireId = result.insertId;
            
            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                await conn.execute(
                    `INSERT INTO questions (questionnaire_id, question_text, question_type, options, 
                     scale_min, scale_max, scale_labels, is_required, order_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        questionnaireId,
                        q.questionText,
                        q.questionType,
                        JSON.stringify(q.options || []),
                        Number.isFinite(Number(q.scaleMin)) ? Number(q.scaleMin) : 1,
                        Number.isFinite(Number(q.scaleMax)) ? Number(q.scaleMax) : 5,
                        JSON.stringify(q.scaleLabels || {}),
                        q.isRequired !== false,
                        i
                    ]
                );
            }
            
            await logAction(conn, req.user.id, 'CREATE_QUESTIONNAIRE', 'questionnaire', questionnaireId, { title });
            
            await conn.commit();
            res.status(201).json({ message: 'Опросник создан', id: questionnaireId });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Ошибка создания опросника:', error);
        res.status(500).json({ error: 'Ошибка создания' });
    }
});

// Получение опросника с вопросами
app.get('/api/questionnaires/:id', authenticateToken, async (req, res) => {
    try {
        const [questionnaires] = await req.db.execute(
            'SELECT * FROM questionnaires WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );
        
        if (questionnaires.length === 0) {
            return res.status(404).json({ error: 'Опросник не найден' });
        }

        if (req.user.role === 'student') {
            const [[assignment]] = await req.db.execute(
                `SELECT id FROM assignments
                 WHERE questionnaire_id = ? AND user_id = ?
                   AND status IN ('assigned', 'started')
                   AND (due_date IS NULL OR due_date >= CURDATE())
                 ORDER BY assigned_at DESC LIMIT 1`,
                [req.params.id, req.user.id]
            );
            if (!assignment) {
                return res.status(403).json({ error: 'Этот тест вам не назначен или срок истёк' });
            }
        } else if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }
        
        const [questions] = await req.db.execute(
            'SELECT * FROM questions WHERE questionnaire_id = ? ORDER BY order_index',
            [req.params.id]
        );
        
        const questionnaire = { ...questionnaires[0] };
        if (req.user.role === 'student') {
            const methodology = parseJsonValue(questionnaire.methodology_data, null);
            questionnaire.instruction = methodology && methodology.instruction
                ? String(methodology.instruction)
                : null;
            delete questionnaire.methodology_data;
            delete questionnaire.created_by;
            delete questionnaire.target_groups;
        }

        res.json({
            ...questionnaire,
            questions: questions.map(q => ({
                ...q,
                options: (() => {
                    const options = parseJsonValue(q.options, []);
                    return req.user.role === 'student'
                        ? options.map(optionText)
                        : options;
                })(),
                scaleLabels: typeof q.scale_labels === 'string' ? JSON.parse(q.scale_labels) : q.scale_labels
            }))
        });
    } catch (error) {
        console.error('Ошибка опросника:', error);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// Удаление опросника/теста (только админ).
// Каскадно удаляет вопросы, назначения и результаты (FK ON DELETE CASCADE).
app.delete('/api/questionnaires/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [result] = await req.db.execute('DELETE FROM questionnaires WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Тест не найден' });
        }
        await logAction(req.db, req.user.id, 'DELETE_QUESTIONNAIRE', 'questionnaire', parseInt(req.params.id));
        res.json({ message: 'Тест удалён' });
    } catch (error) {
        console.error('Ошибка удаления теста:', error);
        res.status(500).json({ error: 'Ошибка удаления теста' });
    }
});

// Получение доступных тестов для студента
app.get('/api/my-tests', authenticateToken, requireStudent, async (req, res) => {
    try {
        await req.db.execute(
            `UPDATE assignments SET status = 'expired'
             WHERE user_id = ? AND status IN ('assigned', 'started')
               AND due_date IS NOT NULL AND due_date < CURDATE()`,
            [req.user.id]
        );
        const [assignments] = await req.db.execute(`
            SELECT a.id as assignment_id, a.status as assignment_status, a.due_date,
                   q.id, q.title, q.description,
                   (SELECT COUNT(*) FROM questions WHERE questionnaire_id = q.id) as questions_count,
                   r.status as result_status, r.completed_at
            FROM assignments a
            JOIN questionnaires q ON a.questionnaire_id = q.id
            LEFT JOIN results r ON r.assignment_id = a.id
            WHERE a.user_id = ? AND q.is_active = TRUE
            ORDER BY a.assigned_at DESC
        `, [req.user.id]);
        
        res.json(assignments);
    } catch (error) {
        console.error('Ошибка тестов:', error);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// Назначение теста студентам
app.post('/api/assign-test', authenticateToken, requireAdmin, async (req, res) => {
    const { questionnaireId, userIds, dueDate } = req.body;
    const qId = Number(questionnaireId);
    const ids = Array.isArray(userIds)
        ? [...new Set(userIds.map(Number).filter(Number.isInteger))]
        : [];

    if (!Number.isInteger(qId) || ids.length === 0) {
        return res.status(400).json({ error: 'Укажите тест и студентов' });
    }
    if (ids.length > 1000) {
        return res.status(400).json({ error: 'За один раз можно назначить не более 1000 студентов' });
    }
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate))) {
        return res.status(400).json({ error: 'Некорректный срок выполнения' });
    }

    const conn = await req.db.getConnection();
    try {
        await conn.beginTransaction();
        const [[questionnaire]] = await conn.execute(
            'SELECT id FROM questionnaires WHERE id = ? AND is_active = TRUE',
            [qId]
        );
        if (!questionnaire) {
            await conn.rollback();
            return res.status(404).json({ error: 'Тест не найден' });
        }

        let assigned = 0;
        let skipped = 0;
        for (const userId of ids) {
            const [[student]] = await conn.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'student' AND is_active = TRUE",
                [userId]
            );
            if (!student) {
                skipped++;
                continue;
            }
            const [[openAssignment]] = await conn.execute(
                `SELECT id FROM assignments
                 WHERE questionnaire_id = ? AND user_id = ?
                   AND status IN ('assigned', 'started')
                 LIMIT 1 FOR UPDATE`,
                [qId, userId]
            );
            if (openAssignment) {
                skipped++;
                continue;
            }
            await conn.execute(
                `INSERT INTO assignments (questionnaire_id, user_id, assigned_by, due_date)
                 VALUES (?, ?, ?, ?)`,
                [qId, userId, req.user.id, dueDate || null]
            );
            assigned++;
        }

        await logAction(conn, req.user.id, 'ASSIGN_TEST', 'assignment', null, {
            questionnaireId: qId, assigned, skipped
        });
        await conn.commit();
        res.json({
            message: `Тест назначен ${assigned} студентам`,
            assigned,
            skipped
        });
    } catch (error) {
        await conn.rollback();
        console.error('Ошибка назначения:', error);
        res.status(500).json({ error: 'Ошибка назначения' });
    } finally {
        conn.release();
    }
});

// ============================================
// API РОУТЫ - ПРОХОЖДЕНИЕ ТЕСТОВ
// ============================================

// Начало прохождения теста
app.post('/api/results/start', authenticateToken, requireStudent, async (req, res) => {
    const assignmentId = Number(req.body && req.body.assignmentId);
    if (!Number.isInteger(assignmentId)) {
        return res.status(400).json({ error: 'Некорректное назначение теста' });
    }

    const conn = await req.db.getConnection();
    try {
        await conn.beginTransaction();
        const [[assignment]] = await conn.execute(
            `SELECT a.id, a.questionnaire_id, a.status, a.due_date
             FROM assignments a
             JOIN questionnaires q ON q.id = a.questionnaire_id AND q.is_active = TRUE
             WHERE a.id = ? AND a.user_id = ?
             FOR UPDATE`,
            [assignmentId, req.user.id]
        );
        if (!assignment) {
            await conn.rollback();
            return res.status(404).json({ error: 'Назначение не найдено' });
        }
        if (assignment.due_date && new Date(assignment.due_date) < new Date(new Date().toDateString())) {
            await conn.execute("UPDATE assignments SET status = 'expired' WHERE id = ?", [assignmentId]);
            await conn.commit();
            return res.status(403).json({ error: 'Срок прохождения теста истёк' });
        }
        if (assignment.status === 'completed' || assignment.status === 'expired') {
            await conn.rollback();
            return res.status(409).json({ error: 'Это назначение уже закрыто' });
        }

        const [[existing]] = await conn.execute(
            'SELECT id, answers, status FROM results WHERE assignment_id = ?',
            [assignmentId]
        );
        if (existing) {
            await conn.commit();
            return res.json({
                resultId: existing.id,
                questionnaireId: assignment.questionnaire_id,
                answers: parseJsonValue(existing.answers, {}),
                message: 'Продолжение теста'
            });
        }

        // Однократная привязка старого черновика, созданного до появления assignment_id.
        const [[legacyDraft]] = await conn.execute(
            `SELECT id, answers FROM results
             WHERE assignment_id IS NULL AND user_id = ? AND questionnaire_id = ? AND status = 'in_progress'
             ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
            [req.user.id, assignment.questionnaire_id]
        );
        if (legacyDraft) {
            await conn.execute(
                'UPDATE results SET assignment_id = ? WHERE id = ?',
                [assignmentId, legacyDraft.id]
            );
            await conn.execute(
                "UPDATE assignments SET status = 'started' WHERE id = ? AND status = 'assigned'",
                [assignmentId]
            );
            await conn.commit();
            return res.json({
                resultId: legacyDraft.id,
                questionnaireId: assignment.questionnaire_id,
                answers: parseJsonValue(legacyDraft.answers, {}),
                message: 'Продолжение теста'
            });
        }

        const [result] = await conn.execute(
            `INSERT INTO results (user_id, questionnaire_id, assignment_id, answers, status)
             VALUES (?, ?, ?, '{}', 'in_progress')`,
            [req.user.id, assignment.questionnaire_id, assignmentId]
        );
        await conn.execute(
            "UPDATE assignments SET status = 'started' WHERE id = ? AND status = 'assigned'",
            [assignmentId]
        );
        await conn.commit();
        res.status(201).json({
            resultId: result.insertId,
            questionnaireId: assignment.questionnaire_id,
            answers: {}
        });
    } catch (error) {
        await conn.rollback();
        console.error('Ошибка начала теста:', error);
        res.status(500).json({ error: 'Ошибка начала теста' });
    } finally {
        conn.release();
    }
});

// Сохранение ответов
app.post('/api/results/save', authenticateToken, requireStudent, async (req, res) => {
    try {
        const { resultId, answers } = req.body;
        if (!Number.isInteger(Number(resultId)) || !isPlainObject(answers)) {
            return res.status(400).json({ error: 'Некорректные данные черновика' });
        }

        const [[result]] = await req.db.execute(
            `SELECT r.id, r.status, a.due_date, a.status AS assignment_status
             FROM results r
             JOIN assignments a ON a.id = r.assignment_id
             WHERE r.id = ? AND r.user_id = ?`,
            [resultId, req.user.id]
        );
        if (!result) {
            return res.status(404).json({ error: 'Результат не найден' });
        }
        if (result.status !== 'in_progress' || result.assignment_status !== 'started') {
            return res.status(409).json({ error: 'Завершённый результат нельзя изменить' });
        }
        if (result.due_date && new Date(result.due_date) < new Date(new Date().toDateString())) {
            return res.status(403).json({ error: 'Срок прохождения теста истёк' });
        }

        await req.db.execute(
            "UPDATE results SET answers = ? WHERE id = ? AND user_id = ? AND status = 'in_progress'",
            [JSON.stringify(answers), resultId, req.user.id]
        );
        res.json({ message: 'Ответы сохранены' });
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

// Завершение теста
app.post('/api/results/complete', authenticateToken, requireStudent, async (req, res) => {
    const { resultId, answers } = req.body || {};
    if (!Number.isInteger(Number(resultId)) || !isPlainObject(answers)) {
        return res.status(400).json({ error: 'Некорректные данные результата' });
    }

    const conn = await req.db.getConnection();
    try {
        await conn.beginTransaction();
        const [[result]] = await conn.execute(
            `SELECT r.id, r.questionnaire_id, r.assignment_id, r.status,
                    a.status AS assignment_status, a.due_date,
                    q.title, q.methodology_data
             FROM results r
             JOIN assignments a ON a.id = r.assignment_id
             JOIN questionnaires q ON q.id = r.questionnaire_id AND q.is_active = TRUE
             WHERE r.id = ? AND r.user_id = ?
             FOR UPDATE`,
            [resultId, req.user.id]
        );
        if (!result) {
            await conn.rollback();
            return res.status(404).json({ error: 'Результат не найден' });
        }
        if (result.status !== 'in_progress' || !['assigned', 'started'].includes(result.assignment_status)) {
            await conn.rollback();
            return res.status(409).json({ error: 'Завершённый результат нельзя изменить' });
        }
        if (result.due_date && new Date(result.due_date) < new Date(new Date().toDateString())) {
            await conn.execute("UPDATE assignments SET status = 'expired' WHERE id = ?", [result.assignment_id]);
            await conn.commit();
            return res.status(403).json({ error: 'Срок прохождения теста истёк' });
        }

        const [questions] = await conn.execute(
            `SELECT question_type, options, scale_min, scale_max, is_required, order_index
             FROM questions WHERE questionnaire_id = ? ORDER BY order_index`,
            [result.questionnaire_id]
        );
        const validationError = validateQuestionnaireAnswers(questions, answers);
        if (validationError) {
            await conn.rollback();
            return res.status(400).json({ error: validationError });
        }

        const methodology = await resolveMethodologyForQuestionnaire(conn, result);
        const methodologyScore = methodology ? scoreMethodology(methodology, answers) : null;
        const finalScore = methodologyScore && Number.isFinite(methodologyScore.total)
            ? methodologyScore.total
            : fallbackQuestionnaireScore(questions, answers);

        const [updated] = await conn.execute(
            `UPDATE results SET answers = ?, score = ?, status = 'completed', completed_at = NOW()
             WHERE id = ? AND user_id = ? AND status = 'in_progress'`,
            [JSON.stringify(answers), finalScore, resultId, req.user.id]
        );
        if (updated.affectedRows !== 1) {
            await conn.rollback();
            return res.status(409).json({ error: 'Результат уже был завершён' });
        }
        await conn.execute(
            "UPDATE assignments SET status = 'completed' WHERE id = ?",
            [result.assignment_id]
        );
        await logAction(conn, req.user.id, 'COMPLETE_TEST', 'result', Number(resultId), { score: finalScore });
        await conn.commit();
        res.json({ message: 'Тест завершён' });
    } catch (error) {
        await conn.rollback();
        console.error('Ошибка завершения:', error);
        res.status(500).json({ error: 'Ошибка завершения' });
    } finally {
        conn.release();
    }
});

// ============================================
// API РОУТЫ - РЕЗУЛЬТАТЫ (ДЛЯ АДМИНА)
// ============================================

// Получение всех результатов
app.get('/api/results', authenticateToken, requireStaff, async (req, res) => {
    try {
        const { questionnaireId, startDate, endDate, level, risk } = req.query;
        const search = String(req.query.search || '').trim().slice(0, 100);
        // Куратор видит результаты только своей группы.
        const groupId = req.user.role === 'curator' ? req.user.group : req.query.groupId;

        let query = `
            SELECT r.id, r.score, r.status, r.completed_at, r.answers,
                   u.id as user_id, u.full_name, u.group_name,
                   q.title as questionnaire_title, q.methodology_data
            FROM results r
            JOIN users u ON r.user_id = u.id
            JOIN questionnaires q ON r.questionnaire_id = q.id
            WHERE r.status = 'completed'
        `;
        const params = [];

        if (req.user.role === 'curator' && !groupId) {
            return res.json([]);
        }
        if (groupId) {
            query += ' AND u.group_name = ?';
            params.push(groupId);
        }
        if (questionnaireId) {
            query += ' AND r.questionnaire_id = ?';
            params.push(parseInt(questionnaireId));
        }
        if (req.query.studentId) {
            query += ' AND r.user_id = ?';
            params.push(parseInt(req.query.studentId));
        }
        if (req.query.resultId) {
            query += ' AND r.id = ?';
            params.push(parseInt(req.query.resultId));
        }
        if (search) {
            query += ' AND LOWER(u.full_name) LIKE ?';
            params.push(`%${search.toLowerCase()}%`);
        }
        if (startDate) {
            query += ' AND r.completed_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND r.completed_at <= ?';
            params.push(endDate + ' 23:59:59');
        }
        
        query += ' ORDER BY r.completed_at DESC';
        
        const [results] = await req.db.execute(query, params);
        
        let parsedResults = results.map(deriveResultMetadata);
        if (level) {
            parsedResults = parsedResults.filter(result =>
                level === 'none'
                    ? !result.interpretation_level
                    : result.interpretation_level === level
            );
        }
        if (risk === 'true' || risk === 'false') {
            const expected = risk === 'true';
            parsedResults = parsedResults.filter(result => result.at_risk === expected);
        }

        res.json(parsedResults);
    } catch (error) {
        console.error('Ошибка результатов:', error);
        res.status(500).json({ error: 'Ошибка загрузки результатов' });
    }
});

// Удаление результата прохождения (только админ)
app.delete('/api/results/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [result] = await req.db.execute('DELETE FROM results WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Результат не найден' });
        }
        await req.db.execute(
            "DELETE FROM ai_analyses WHERE scope = 'result' AND target_id = ?",
            [String(req.params.id)]
        );
        await logAction(req.db, req.user.id, 'DELETE_RESULT', 'result', parseInt(req.params.id));
        res.json({ message: 'Результат удалён' });
    } catch (error) {
        console.error('Ошибка удаления результата:', error);
        res.status(500).json({ error: 'Ошибка удаления результата' });
    }
});

// Получение статистики по группам
app.get('/api/statistics/groups', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [stats] = await req.db.execute(`
            SELECT 
                u.group_name,
                COUNT(DISTINCT u.id) as total_students,
                COUNT(DISTINCT CASE WHEN r.status = 'completed' THEN r.id END) as completed_tests,
                AVG(CASE WHEN r.status = 'completed' THEN r.score END) as avg_score
            FROM users u
            LEFT JOIN results r ON u.id = r.user_id
            WHERE u.role = 'student' AND u.is_active = TRUE
            GROUP BY u.group_name
            ORDER BY u.group_name
        `);
        
        res.json(stats);
    } catch (error) {
        console.error('Ошибка статистики:', error);
        res.status(500).json({ error: 'Ошибка загрузки статистики' });
    }
});

// Экспорт результатов в JSON
app.get('/api/export/json', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [results] = await req.db.execute(`
            SELECT 
                u.full_name, u.group_name,
                q.title as test_title,
                r.score, r.status, r.completed_at,
                r.answers
            FROM results r
            JOIN users u ON r.user_id = u.id
            JOIN questionnaires q ON r.questionnaire_id = q.id
            WHERE r.status = 'completed'
            ORDER BY u.group_name, u.full_name, q.title
        `);
        
        const exportData = {
            exportDate: new Date().toISOString(),
            totalRecords: results.length,
            data: results.map(r => ({
                ...r,
                answers: typeof r.answers === 'string' ? JSON.parse(r.answers) : r.answers
            }))
        };
        
        res.setHeader('Content-Disposition', 'attachment; filename=diagnostic-results.json');
        res.json(exportData);
    } catch (error) {
        console.error('Ошибка экспорта:', error);
        res.status(500).json({ error: 'Ошибка экспорта' });
    }
});

// ============================================
// API РОУТЫ - ИИ-АНАЛИЗ
// ============================================

const AI_RESULT_ROW_SQL = `
    SELECT r.id, r.answers, r.score, r.completed_at,
           u.id AS user_id, u.group_name, u.birth_date,
           q.title AS questionnaire_title, q.methodology_data
    FROM results r
    JOIN users u ON r.user_id = u.id
    JOIN questionnaires q ON r.questionnaire_id = q.id
    WHERE r.status = 'completed'
`;

// Валидация scope/targetId + скоупинг куратора. Возвращает {targetId, ...},
// при ошибке бросает Error со statusCode. Чужие result/student для куратора — 404,
// чтобы не раскрывать их существование.
async function resolveAiTarget(req) {
    const scope = String((req.body && req.body.scope) || req.query.scope || '').trim();
    const rawTarget = String((req.body && req.body.targetId) || req.query.targetId || '').trim();
    const fail = (statusCode, message) => {
        const error = new Error(message);
        error.statusCode = statusCode;
        throw error;
    };
    if (!['result', 'student', 'group'].includes(scope)) fail(400, 'Некорректная область анализа');
    const curatorGroup = req.user.role === 'curator' ? String(req.user.group || '') : null;

    if (scope === 'group') {
        const groupName = rawTarget.slice(0, 100);
        if (!groupName) fail(400, 'Укажите группу');
        if (curatorGroup !== null && groupName !== curatorGroup) fail(403, 'Доступ запрещён');
        const [[{ n }]] = await req.db.execute(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND is_active = TRUE AND group_name = ?",
            [groupName]
        );
        if (Number(n) === 0) fail(404, 'В группе нет студентов');
        return { scope, targetId: groupName };
    }

    const numericId = parseInt(rawTarget, 10);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) fail(400, 'Некорректный идентификатор');

    if (scope === 'result') {
        const [rows] = await req.db.execute(`${AI_RESULT_ROW_SQL} AND r.id = ?`, [numericId]);
        if (rows.length === 0) fail(404, 'Результат не найден');
        if (curatorGroup !== null && String(rows[0].group_name || '') !== curatorGroup) fail(404, 'Результат не найден');
        return { scope, targetId: String(numericId), resultRow: rows[0] };
    }

    // scope === 'student'
    const [students] = await req.db.execute(
        "SELECT id, group_name, birth_date FROM users WHERE id = ? AND role = 'student' AND is_active = TRUE",
        [numericId]
    );
    if (students.length === 0) fail(404, 'Студент не найден');
    if (curatorGroup !== null && String(students[0].group_name || '') !== curatorGroup) fail(404, 'Студент не найден');
    return { scope, targetId: String(numericId), student: students[0] };
}

// Доступность функции — фронтенд по этому флагу показывает кнопки.
app.get('/api/ai/status', authenticateToken, requireStaff, (req, res) => {
    res.json({ enabled: AI_ANALYSIS_ENABLED, model: AI_ANALYSIS_ENABLED ? OPENWEBUI_MODEL : null });
});

// Сохранённый (кэшированный) анализ; 200 с null, если ещё не создавался.
app.get('/api/ai/analysis', authenticateToken, requireStaff, async (req, res) => {
    try {
        const target = await resolveAiTarget(req);
        const [rows] = await req.db.execute(
            `SELECT a.content, a.model, a.created_at, a.source_count, u.full_name AS created_by_name
             FROM ai_analyses a
             LEFT JOIN users u ON a.created_by = u.id
             WHERE a.scope = ? AND a.target_id = ?`,
            [target.scope, target.targetId]
        );
        res.json({ analysis: rows.length ? rows[0] : null });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
        console.error('Ошибка чтения ИИ-анализа:', error);
        res.status(500).json({ error: 'Ошибка загрузки анализа' });
    }
});

// Защита от параллельной генерации одного и того же анализа.
const aiGenerationsInFlight = new Set();

// Генерация (и перегенерация) анализа: собирает обезличенные данные,
// вызывает LLM и перезаписывает кэш (хранится только последний вариант).
app.post('/api/ai/analysis', authenticateToken, requireStaff, async (req, res) => {
    let inFlightKey = null;
    try {
        const target = await resolveAiTarget(req);
        inFlightKey = `${req.user.tenantCode || 'default'}:${target.scope}:${target.targetId}`;
        if (aiGenerationsInFlight.has(inFlightKey)) {
            inFlightKey = null;
            return res.status(429).json({ error: 'Анализ уже формируется, подождите' });
        }
        aiGenerationsInFlight.add(inFlightKey);

        let messages;
        let sourceCount;
        if (target.scope === 'result') {
            const row = target.resultRow;
            messages = buildResultPrompt(buildScoredSummary(row), {
                group: row.group_name,
                age: studentAgeFromBirthDate(row.birth_date)
            });
            sourceCount = 1;
        } else if (target.scope === 'student') {
            const [rows] = await req.db.execute(
                `${AI_RESULT_ROW_SQL} AND r.user_id = ? ORDER BY r.completed_at ASC`,
                [Number(target.targetId)]
            );
            if (rows.length === 0) {
                return res.status(400).json({ error: 'Нет завершённых результатов для анализа' });
            }
            messages = buildStudentPrompt(
                { group: target.student.group_name, age: studentAgeFromBirthDate(target.student.birth_date) },
                rows.map(buildScoredSummary)
            );
            sourceCount = rows.length;
        } else {
            const [rows] = await req.db.execute(
                `${AI_RESULT_ROW_SQL} AND u.group_name = ? ORDER BY r.user_id, r.completed_at ASC`,
                [target.targetId]
            );
            if (rows.length === 0) {
                return res.status(400).json({ error: 'Нет завершённых результатов для анализа' });
            }
            const byStudent = new Map();
            rows.forEach(row => {
                if (!byStudent.has(row.user_id)) {
                    byStudent.set(row.user_id, {
                        age: studentAgeFromBirthDate(row.birth_date),
                        results: []
                    });
                }
                byStudent.get(row.user_id).results.push(buildScoredSummary(row));
            });
            messages = buildGroupPrompt(target.targetId, [...byStudent.values()]);
            sourceCount = rows.length;
        }

        const content = await callLlm(messages);
        const [upsert] = await req.db.execute(
            `INSERT INTO ai_analyses (scope, target_id, model, source_count, content, created_by)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 model = VALUES(model), source_count = VALUES(source_count),
                 content = VALUES(content), created_by = VALUES(created_by),
                 created_at = CURRENT_TIMESTAMP`,
            [target.scope, target.targetId, OPENWEBUI_MODEL, sourceCount, content, req.user.id]
        );
        await logAction(req.db, req.user.id, 'AI_ANALYZE', 'ai_analysis', upsert.insertId || null, {
            scope: target.scope,
            targetId: target.targetId
        });
        res.json({
            analysis: {
                content,
                model: OPENWEBUI_MODEL,
                source_count: sourceCount,
                created_at: new Date().toISOString()
            }
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
        console.error('Ошибка генерации ИИ-анализа:', error);
        res.status(500).json({ error: 'Ошибка генерации анализа' });
    } finally {
        if (inFlightKey) aiGenerationsInFlight.delete(inFlightKey);
    }
});

// ============================================
// API РОУТЫ - СПРАВОЧНИКИ
// ============================================

// Получение списка групп
app.get('/api/groups', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [groups] = await req.db.execute(`
            SELECT DISTINCT group_name 
            FROM users 
            WHERE role = 'student' AND is_active = TRUE AND group_name IS NOT NULL
            ORDER BY group_name
        `);
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// ============================================
// АНОНИМНЫЕ ОПРОСЫ — отдельный неперсональный контур
// ============================================

// Доступные встроенные шаблоны для психолога.
app.get('/api/anonymous-campaigns/templates', authenticateToken, requireAdmin, (req, res) => {
    res.json(PSY_ANONYMOUS_SURVEYS.map(survey => ({
        id: survey.id,
        title: survey.title,
        ageRange: survey.ageRange,
        questionsCount: survey.questions.length
    })));
});

// Кампании колледжа и число обезличенных ответов.
app.get('/api/anonymous-campaigns', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [rows] = await req.db.execute(`
            SELECT c.id, c.survey_key, c.title, c.target_group, c.access_token,
                   c.is_active, c.closes_at, c.created_at, COUNT(r.id) AS response_count
            FROM anonymous_campaigns c
            LEFT JOIN anonymous_responses r ON r.campaign_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `);
        res.json(rows.map(row => ({
            ...row,
            public_path: `/survey/${encodeURIComponent(req.tenant.code)}/${row.access_token}`
        })));
    } catch (error) {
        console.error('Ошибка списка анонимных опросов:', error);
        res.status(500).json({ error: 'Ошибка загрузки анонимных опросов' });
    }
});

// Создание ссылки на встроенную анонимную анкету.
app.post('/api/anonymous-campaigns', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const survey = findAnonymousSurvey(req.body && req.body.surveyKey);
        if (!survey) return res.status(400).json({ error: 'Неизвестный шаблон опроса' });

        const targetGroup = String(req.body.targetGroup || '').trim().slice(0, 100) || null;
        const closesAtRaw = String(req.body.closesAt || '').trim();
        let closesAt = null;
        if (closesAtRaw) {
            const parsed = new Date(closesAtRaw);
            if (Number.isNaN(parsed.getTime())) {
                return res.status(400).json({ error: 'Некорректная дата закрытия' });
            }
            closesAt = parsed;
        }
        const accessToken = crypto.randomBytes(32).toString('hex');
        const [result] = await req.db.execute(
            `INSERT INTO anonymous_campaigns
             (survey_key, title, survey_data, target_group, access_token, closes_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                survey.id,
                survey.title,
                JSON.stringify(survey),
                targetGroup,
                accessToken,
                closesAt,
                req.user.id
            ]
        );
        await logAction(req.db, req.user.id, 'CREATE_ANONYMOUS_CAMPAIGN', 'anonymous_campaign', result.insertId, {
            surveyKey: survey.id,
            targetGroup
        });
        res.status(201).json({
            id: result.insertId,
            public_path: `/survey/${encodeURIComponent(req.tenant.code)}/${accessToken}`
        });
    } catch (error) {
        console.error('Ошибка создания анонимного опроса:', error);
        res.status(500).json({ error: 'Ошибка создания анонимного опроса' });
    }
});

// Открытие/закрытие приёма ответов.
app.patch('/api/anonymous-campaigns/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (typeof req.body.is_active !== 'boolean') {
            return res.status(400).json({ error: 'is_active должен быть логическим значением' });
        }
        const [result] = req.body.is_active
            ? await req.db.execute(
                'UPDATE anonymous_campaigns SET is_active = TRUE, closes_at = NULL WHERE id = ?',
                [req.params.id]
            )
            : await req.db.execute(
                'UPDATE anonymous_campaigns SET is_active = FALSE WHERE id = ?',
                [req.params.id]
            );
        if (!result.affectedRows) return res.status(404).json({ error: 'Опрос не найден' });
        await logAction(req.db, req.user.id, 'UPDATE_ANONYMOUS_CAMPAIGN', 'anonymous_campaign', Number(req.params.id), {
            isActive: req.body.is_active
        });
        res.json({ message: 'Статус опроса изменён' });
    } catch (error) {
        console.error('Ошибка изменения анонимного опроса:', error);
        res.status(500).json({ error: 'Ошибка изменения опроса' });
    }
});

// Агрегированная статистика без выдачи отдельных анкет.
app.get('/api/anonymous-campaigns/:id/report', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [[campaign]] = await req.db.execute(
            `SELECT id, title, survey_data, target_group, created_at, closes_at, is_active
             FROM anonymous_campaigns WHERE id = ?`,
            [req.params.id]
        );
        if (!campaign) return res.status(404).json({ error: 'Опрос не найден' });
        const survey = parseJsonValue(campaign.survey_data, null);
        if (!survey || !Array.isArray(survey.questions)) {
            return res.status(500).json({ error: 'Повреждён снимок опроса' });
        }
        const [responses] = await req.db.execute(
            'SELECT answers FROM anonymous_responses WHERE campaign_id = ? ORDER BY id',
            [req.params.id]
        );
        const aggregates = survey.questions.map(question => {
            const counts = Object.fromEntries(question.options.map(option => [option, 0]));
            let answered = 0;
            for (const response of responses) {
                const answers = parseJsonValue(response.answers, {});
                const value = answers[question.id];
                if (Object.prototype.hasOwnProperty.call(counts, value)) {
                    counts[value]++;
                    answered++;
                }
            }
            return {
                id: question.id,
                text: question.text,
                answered,
                skipped: responses.length - answered,
                options: question.options.map(option => ({
                    text: option,
                    count: counts[option],
                    percent: answered ? Number((counts[option] * 100 / answered).toFixed(1)) : 0
                }))
            };
        });
        res.json({
            campaign: {
                id: campaign.id,
                title: campaign.title,
                target_group: campaign.target_group,
                created_at: campaign.created_at,
                closes_at: campaign.closes_at,
                is_active: Boolean(campaign.is_active)
            },
            response_count: responses.length,
            questions: aggregates
        });
    } catch (error) {
        console.error('Ошибка отчёта анонимного опроса:', error);
        res.status(500).json({ error: 'Ошибка загрузки отчёта' });
    }
});

app.delete('/api/anonymous-campaigns/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [result] = await req.db.execute('DELETE FROM anonymous_campaigns WHERE id = ?', [req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Опрос не найден' });
        await logAction(req.db, req.user.id, 'DELETE_ANONYMOUS_CAMPAIGN', 'anonymous_campaign', Number(req.params.id));
        res.json({ message: 'Анонимный опрос и его ответы удалены' });
    } catch (error) {
        console.error('Ошибка удаления анонимного опроса:', error);
        res.status(500).json({ error: 'Ошибка удаления опроса' });
    }
});

// Публичное чтение анкеты по коду колледжа и случайному токену.
app.get('/api/anonymous-surveys/:college/:token', async (req, res) => {
    try {
        const tenant = await getTenantByCode(req.params.college);
        if (!tenant) return res.status(404).json({ error: 'Опрос не найден' });
        const db = tenantPool(tenant.db_name);
        const [[campaign]] = await db.execute(
            `SELECT id, title, survey_data, target_group
             FROM anonymous_campaigns
             WHERE access_token = ? AND is_active = TRUE
               AND (closes_at IS NULL OR closes_at >= NOW())`,
            [req.params.token]
        );
        if (!campaign) return res.status(404).json({ error: 'Опрос закрыт или ссылка недействительна' });
        res.json({
            campaign: {
                id: campaign.id,
                title: campaign.title,
                target_group: campaign.target_group
            },
            survey: parseJsonValue(campaign.survey_data, null)
        });
    } catch (error) {
        console.error('Ошибка публичного анонимного опроса:', error);
        res.status(500).json({ error: 'Ошибка загрузки опроса' });
    }
});

// Сохранение ответа без user_id, ФИО, логина и IP-адреса.
app.post('/api/anonymous-surveys/:college/:token/responses', async (req, res) => {
    try {
        const tenant = await getTenantByCode(req.params.college);
        if (!tenant) return res.status(404).json({ error: 'Опрос не найден' });
        const db = tenantPool(tenant.db_name);
        const [[campaign]] = await db.execute(
            `SELECT id, survey_data
             FROM anonymous_campaigns
             WHERE access_token = ? AND is_active = TRUE
               AND (closes_at IS NULL OR closes_at >= NOW())`,
            [req.params.token]
        );
        if (!campaign) return res.status(404).json({ error: 'Опрос закрыт или ссылка недействительна' });
        const survey = parseJsonValue(campaign.survey_data, null);
        const answers = req.body && req.body.answers;
        const validationError = survey ? validateAnonymousAnswers(survey, answers) : 'Повреждён снимок опроса';
        if (validationError) return res.status(400).json({ error: validationError });

        const cleanedAnswers = {};
        for (const question of survey.questions) {
            if (isAnonymousQuestionVisible(question, answers) && answers[question.id] != null) {
                cleanedAnswers[question.id] = answers[question.id];
            }
        }
        await db.execute(
            'INSERT INTO anonymous_responses (campaign_id, answers) VALUES (?, ?)',
            [campaign.id, JSON.stringify(cleanedAnswers)]
        );
        res.status(201).json({ message: 'Анонимный ответ сохранён' });
    } catch (error) {
        console.error('Ошибка сохранения анонимного ответа:', error);
        res.status(500).json({ error: 'Ошибка сохранения ответа' });
    }
});

// ============================================
// API РОУТЫ - ПОЛЬЗОВАТЕЛЬСКИЕ МЕТОДИКИ (БД)
// ============================================

// Список методик доступен только персоналу: формулы и ключи не раскрываются студентам.
app.get('/api/methodologies', authenticateToken, requireStaff, async (req, res) => {
    try {
        const [rows] = await req.db.execute(
            'SELECT id, meth_key, title, data FROM methodologies WHERE is_active = TRUE ORDER BY title'
        );
        const list = rows.map(r => {
            const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            return { ...data, id: data.id || r.meth_key || ('db-' + r.id), _dbId: r.id, title: r.title };
        });
        res.json(list);
    } catch (error) {
        console.error('Ошибка загрузки методик:', error);
        res.status(500).json({ error: 'Ошибка загрузки методик' });
    }
});

// Создание методики (админ)
app.post('/api/methodologies', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const data = req.body || {};
        if (!data.title || !Array.isArray(data.questions) || data.questions.length === 0) {
            return res.status(400).json({ error: 'Укажите название и хотя бы один вопрос' });
        }
        const [sameTitle] = await req.db.execute(
            'SELECT id FROM methodologies WHERE title = ? LIMIT 1',
            [String(data.title).trim()]
        );
        if (findMethodologyByTitle(data.title) || sameTitle.length) {
            return res.status(400).json({ error: 'Методика с таким названием уже существует' });
        }
        const methKey = data.id || ('m-' + Date.now());
        data.id = methKey;
        const [result] = await req.db.execute(
            'INSERT INTO methodologies (meth_key, title, data, created_by) VALUES (?, ?, ?, ?)',
            [methKey, data.title, JSON.stringify(data), req.user.id]
        );
        await logAction(req.db, req.user.id, 'CREATE_METHODOLOGY', 'methodology', result.insertId, { title: data.title });
        res.status(201).json({ id: result.insertId, message: 'Методика создана' });
    } catch (error) {
        console.error('Ошибка создания методики:', error);
        if (error.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Методика с таким ключом уже существует' });
        res.status(500).json({ error: 'Ошибка создания методики' });
    }
});

// Обновление методики (админ)
app.put('/api/methodologies/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const data = req.body || {};
        if (!data.title || !Array.isArray(data.questions) || data.questions.length === 0) {
            return res.status(400).json({ error: 'Укажите название и хотя бы один вопрос' });
        }
        const [sameTitle] = await req.db.execute(
            'SELECT id FROM methodologies WHERE title = ? AND id <> ? LIMIT 1',
            [String(data.title).trim(), req.params.id]
        );
        const builtin = findMethodologyByTitle(data.title);
        if (sameTitle.length || builtin) {
            return res.status(400).json({ error: 'Методика с таким названием уже существует' });
        }
        const [result] = await req.db.execute(
            'UPDATE methodologies SET title = ?, data = ?, updated_at = NOW() WHERE id = ?',
            [data.title, JSON.stringify(data), req.params.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Методика не найдена' });
        }
        await logAction(req.db, req.user.id, 'UPDATE_METHODOLOGY', 'methodology', parseInt(req.params.id), { title: data.title });
        res.json({ message: 'Методика обновлена' });
    } catch (error) {
        console.error('Ошибка обновления методики:', error);
        res.status(500).json({ error: 'Ошибка обновления методики' });
    }
});

// Удаление методики (админ)
app.delete('/api/methodologies/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [result] = await req.db.execute('DELETE FROM methodologies WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Методика не найдена' });
        }
        await logAction(req.db, req.user.id, 'DELETE_METHODOLOGY', 'methodology', parseInt(req.params.id));
        res.json({ message: 'Методика удалена' });
    } catch (error) {
        console.error('Ошибка удаления методики:', error);
        res.status(500).json({ error: 'Ошибка удаления методики' });
    }
});

// ============================================
// API РОУТЫ - СМЕНА ПАРОЛЯ
// ============================================

// Смена собственного пароля (студент, психолог или супер-админ)
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Укажите текущий и новый пароль' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ error: 'Новый пароль должен быть не короче 8 символов' });
        }

        // Супер-админ хранится в control-БД, остальные — в БД своего колледжа.
        if (req.user.role === 'super_admin') {
            if (!controlPool) return res.status(503).json({ error: 'Control-БД недоступна' });
            const [rows] = await controlPool.execute('SELECT * FROM platform_admins WHERE id = ?', [req.user.id]);
            if (rows.length === 0 || !(await bcrypt.compare(currentPassword, rows[0].password))) {
                return res.status(401).json({ error: 'Текущий пароль неверный' });
            }
            const hash = await bcrypt.hash(newPassword, 10);
            await controlPool.execute(
                'UPDATE platform_admins SET password = ?, token_version = token_version + 1 WHERE id = ?',
                [hash, req.user.id]
            );
            return res.json({ message: 'Пароль изменён' });
        }

        const [rows] = await req.db.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0 || !(await bcrypt.compare(currentPassword, rows[0].password))) {
            return res.status(401).json({ error: 'Текущий пароль неверный' });
        }
        const hash = await bcrypt.hash(newPassword, 10);
        await req.db.execute(
            'UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?',
            [hash, req.user.id]
        );
        await logAction(req.db, req.user.id, 'CHANGE_PASSWORD', 'user', req.user.id);
        res.json({ message: 'Пароль изменён' });
    } catch (error) {
        console.error('Ошибка смены пароля:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============================================
// API РОУТЫ - ПЛАТФОРМА (СУПЕР-АДМИН): провижининг колледжей
// ============================================

// Список колледжей с числом студентов
app.get('/api/platform/tenants', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const [tenants] = await controlPool.execute(
            'SELECT id, code, name, db_name, is_active, created_at FROM tenants ORDER BY created_at'
        );
        // Считаем студентов по каждому колледжу (best-effort, без падения на недоступной БД).
        for (const t of tenants) {
            try {
                const [[row]] = await tenantPool(t.db_name).execute(
                    "SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND is_active = TRUE"
                );
                t.student_count = row.n;
            } catch (_) {
                t.student_count = null;
            }
        }
        res.json(tenants);
    } catch (error) {
        console.error('Ошибка списка колледжей:', error);
        res.status(500).json({ error: 'Ошибка загрузки колледжей' });
    }
});

// Создание колледжа: новая БД + схема + первый админ-психолог
app.post('/api/platform/tenants', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { code, name, adminUsername, adminPassword, adminFullName } = req.body || {};
        const safeCode = safeDbName(String(code || '').toLowerCase());

        if (!safeCode || !name || !adminUsername || !adminPassword) {
            return res.status(400).json({ error: 'Укажите код, название колледжа, логин и пароль администратора' });
        }
        if (['platform', 'default'].includes(safeCode)) {
            return res.status(400).json({ error: 'Код колледжа зарезервирован' });
        }
        if (String(adminPassword).length < 8) {
            return res.status(400).json({ error: 'Пароль администратора должен быть не короче 8 символов' });
        }

        const [existing] = await controlPool.execute('SELECT id FROM tenants WHERE code = ?', [safeCode]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Колледж с таким кодом уже существует' });
        }

        const dbName = safeDbName(TENANT_DB_PREFIX + safeCode);

        // 1. Создаём БД колледжа и накатываем схему.
        await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        const db = tenantPool(dbName);
        await ensureTenantSchema(db);

        // 2. Первый админ-психолог колледжа.
        const hash = await bcrypt.hash(adminPassword, 10);
        await db.execute(
            'INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)',
            [adminUsername, hash, adminFullName || 'Администратор', 'admin']
        );

        // 3. Регистрируем колледж в control-БД.
        await controlPool.execute(
            'INSERT INTO tenants (code, name, db_name) VALUES (?, ?, ?)',
            [safeCode, name, dbName]
        );

        res.status(201).json({ message: 'Колледж создан', code: safeCode, db_name: dbName });
    } catch (error) {
        console.error('Ошибка создания колледжа:', error);
        res.status(500).json({ error: 'Ошибка создания колледжа' });
    }
});

// Активация/деактивация колледжа
app.patch('/api/platform/tenants/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { is_active } = req.body || {};
        if (typeof is_active !== 'boolean') {
            return res.status(400).json({ error: 'is_active должен быть логическим значением' });
        }
        if (is_active) {
            const [[tenant]] = await controlPool.execute(
                'SELECT db_name FROM tenants WHERE id = ? AND code <> ?',
                [req.params.id, 'default']
            );
            if (!tenant) {
                return res.status(404).json({ error: 'Колледж не найден или защищён от изменения' });
            }
            await ensureTenantSchema(tenantPool(tenant.db_name));
        }
        const [result] = await controlPool.execute(
            'UPDATE tenants SET is_active = ? WHERE id = ? AND code <> ?',
            [is_active ? 1 : 0, req.params.id, 'default']
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Колледж не найден или защищён от отключения' });
        }
        res.json({ message: 'Колледж обновлён' });
    } catch (error) {
        console.error('Ошибка обновления колледжа:', error);
        res.status(500).json({ error: 'Ошибка обновления колледжа' });
    }
});

// Безвозвратное удаление колледжа вместе с его отдельной БД.
app.delete('/api/platform/tenants/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
    const confirmationCode = String(req.body && req.body.confirmCode || '').trim();
    const conn = await controlPool.getConnection();
    let dbDropped = false;
    try {
        await conn.beginTransaction();
        const [[tenant]] = await conn.execute(
            'SELECT id, code, name, db_name FROM tenants WHERE id = ? FOR UPDATE',
            [req.params.id]
        );
        if (!tenant) {
            await conn.rollback();
            return res.status(404).json({ error: 'Колледж не найден' });
        }
        if (tenant.code === 'default' || tenant.db_name === DEFAULT_DB_NAME) {
            await conn.rollback();
            return res.status(403).json({ error: 'Колледж по умолчанию защищён от удаления' });
        }
        if (confirmationCode !== tenant.code) {
            await conn.rollback();
            return res.status(400).json({ error: 'Для подтверждения введите точный код колледжа' });
        }
        const dbName = safeDbName(tenant.db_name);
        if (
            dbName !== tenant.db_name ||
            !dbName.startsWith(TENANT_DB_PREFIX) ||
            dbName === safeDbName(CONTROL_DB_NAME)
        ) {
            await conn.rollback();
            return res.status(400).json({ error: 'Имя БД колледжа не прошло проверку безопасности' });
        }

        await conn.execute('DELETE FROM tenants WHERE id = ?', [tenant.id]);
        const cachedPool = tenantPools.get(dbName);
        if (cachedPool) {
            tenantPools.delete(dbName);
            await cachedPool.end();
        }
        await adminPool.query(`DROP DATABASE \`${dbName}\``);
        dbDropped = true;
        await conn.commit();
        res.json({ message: `Колледж «${tenant.name}» и его БД удалены` });
    } catch (error) {
        try {
            await conn.rollback();
        } catch (_) {}
        console.error('Ошибка удаления колледжа:', error);
        res.status(500).json({
            error: dbDropped
                ? 'БД удалена, но реестр не обновлён. Требуется ручная проверка control-БД.'
                : 'Ошибка удаления колледжа'
        });
    } finally {
        conn.release();
    }
});

// Список пользователей выбранного колледжа для полноценного управления супер-администратором.
app.get('/api/platform/tenants/:id/users', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const [[tenant]] = await controlPool.execute(
            'SELECT id, code, name, db_name, is_active FROM tenants WHERE id = ?',
            [req.params.id]
        );
        if (!tenant) return res.status(404).json({ error: 'Колледж не найден' });

        const db = tenantPool(tenant.db_name);
        let query = `
            SELECT id, username, full_name, role, birth_date, group_name,
                   email, phone, is_active, created_at
            FROM users
            WHERE 1 = 1
        `;
        const params = [];
        const search = String(req.query.search || '').trim();
        if (search) {
            query += ' AND (full_name LIKE ? OR username LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        const role = String(req.query.role || '').trim();
        if (role) {
            if (!['admin', 'curator', 'student'].includes(role)) {
                return res.status(400).json({ error: 'Некорректная роль' });
            }
            query += ' AND role = ?';
            params.push(role);
        }
        const status = String(req.query.status || '').trim();
        if (status) {
            if (!['active', 'inactive'].includes(status)) {
                return res.status(400).json({ error: 'Некорректный статус' });
            }
            query += ' AND is_active = ?';
            params.push(status === 'active' ? 1 : 0);
        }
        query += ' ORDER BY FIELD(role, "admin", "curator", "student"), full_name LIMIT 500';
        const [users] = await db.execute(query, params);
        res.json(users);
    } catch (error) {
        console.error('Ошибка списка пользователей колледжа:', error);
        res.status(500).json({ error: 'Ошибка загрузки пользователей' });
    }
});

// Создание пользователя в выбранном колледже. Данные всегда записываются в БД этого колледжа.
app.post('/api/platform/tenants/:id/users', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const [[tenant]] = await controlPool.execute(
            'SELECT id, code, db_name FROM tenants WHERE id = ?',
            [req.params.id]
        );
        if (!tenant) return res.status(404).json({ error: 'Колледж не найден' });

        const {
            username, password, full_name, role,
            birth_date, group_name, email, phone
        } = req.body || {};
        if (!username || !full_name || !role || !password) {
            return res.status(400).json({ error: 'Укажите логин, пароль, ФИО и роль' });
        }
        if (!['admin', 'curator', 'student'].includes(role)) {
            return res.status(400).json({ error: 'Некорректная роль' });
        }
        if (String(password).length < 8) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
        }
        if (role === 'student' && !birth_date) {
            return res.status(400).json({ error: 'Для студента укажите дату рождения' });
        }
        if (role === 'curator' && !String(group_name || '').trim()) {
            return res.status(400).json({ error: 'Для куратора укажите группу' });
        }

        const db = tenantPool(tenant.db_name);
        const hash = await bcrypt.hash(String(password), 10);
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [created] = await conn.execute(
                `INSERT INTO users
                    (username, password, full_name, role, birth_date, group_name, email, phone)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    String(username).trim(), hash, String(full_name).trim(), role,
                    birth_date || null, String(group_name || '').trim() || null,
                    String(email || '').trim() || null, String(phone || '').trim() || null
                ]
            );
            if (role === 'student') {
                await conn.execute(
                    `INSERT INTO student_profiles (user_id, family_type, lives_with)
                     VALUES (?, 'full', NULL)`,
                    [created.insertId]
                );
            }
            await logAction(conn, null, 'PLATFORM_CREATE_USER', 'user', created.insertId, {
                bySuperAdmin: req.user.id,
                tenantCode: tenant.code,
                username: String(username).trim(),
                role
            });
            await conn.commit();
            res.status(201).json({ message: 'Пользователь создан', id: created.insertId });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Ошибка создания пользователя супер-администратором:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
        }
        res.status(500).json({ error: 'Ошибка создания пользователя' });
    }
});

// Редактирование основных данных пользователя. Роль не меняется, чтобы не нарушить связанные данные.
app.put('/api/platform/tenants/:id/users/:userId', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const [[tenant]] = await controlPool.execute(
            'SELECT id, code, db_name FROM tenants WHERE id = ?',
            [req.params.id]
        );
        if (!tenant) return res.status(404).json({ error: 'Колледж не найден' });

        const db = tenantPool(tenant.db_name);
        const [[target]] = await db.execute(
            'SELECT id, role FROM users WHERE id = ?',
            [req.params.userId]
        );
        if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

        const { username, full_name, birth_date, group_name, email, phone } = req.body || {};
        if (!username || !full_name) {
            return res.status(400).json({ error: 'Укажите логин и ФИО' });
        }
        if (target.role === 'student' && !birth_date) {
            return res.status(400).json({ error: 'Для студента укажите дату рождения' });
        }
        if (target.role === 'curator' && !String(group_name || '').trim()) {
            return res.status(400).json({ error: 'Для куратора укажите группу' });
        }

        const [updated] = await db.execute(
            `UPDATE users
             SET username = ?, full_name = ?, birth_date = ?, group_name = ?,
                 email = ?, phone = ?, updated_at = NOW()
             WHERE id = ?`,
            [
                String(username).trim(), String(full_name).trim(), birth_date || null,
                String(group_name || '').trim() || null,
                String(email || '').trim() || null, String(phone || '').trim() || null,
                req.params.userId
            ]
        );
        if (updated.affectedRows === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        await logAction(db, null, 'PLATFORM_UPDATE_USER', 'user', Number(req.params.userId), {
            bySuperAdmin: req.user.id,
            tenantCode: tenant.code,
            username: String(username).trim()
        });
        res.json({ message: 'Пользователь обновлён' });
    } catch (error) {
        console.error('Ошибка обновления пользователя супер-администратором:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
        }
        res.status(500).json({ error: 'Ошибка обновления пользователя' });
    }
});

// Выборочные операции с пользователями выбранного колледжа.
app.post('/api/platform/tenants/:id/users/bulk', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const [[tenant]] = await controlPool.execute(
            'SELECT id, code, db_name FROM tenants WHERE id = ?',
            [req.params.id]
        );
        if (!tenant) return res.status(404).json({ error: 'Колледж не найден' });

        const { userIds, action, newPassword } = req.body || {};
        const db = tenantPool(tenant.db_name);
        const result = await bulkUpdateUsers(db, {
            userIds,
            action,
            newPassword,
            protectLastAdmin: true
        });
        await logAction(db, null, `PLATFORM_BULK_USER_${String(action).toUpperCase()}`, 'user', null, {
            bySuperAdmin: req.user.id,
            tenantCode: tenant.code,
            userIds: result.ids,
            users: result.targets.map(target => target.username)
        });
        const actionLabel = action === 'reset_password'
            ? 'Пароли изменены'
            : action === 'activate'
                ? 'Пользователи включены'
                : 'Пользователи отключены';
        res.json({ message: `${actionLabel}: ${result.ids.length}`, affected: result.ids.length });
    } catch (error) {
        console.error('Ошибка выборочной операции супер-администратора:', error);
        res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'Ошибка операции с пользователями'
        });
    }
});

// Сброс пароля ЛЮБОГО пользователя в ЛЮБОМ колледже (поддержка). Только супер-админ.
app.post('/api/platform/reset-password', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { tenantId, userId, newPassword } = req.body || {};
        if (!tenantId || !userId || !newPassword) {
            return res.status(400).json({ error: 'Укажите колледж, пользователя и новый пароль' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
        }

        const [[tenant]] = await controlPool.execute('SELECT * FROM tenants WHERE id = ?', [tenantId]);
        if (!tenant) return res.status(404).json({ error: 'Колледж не найден' });

        const db = tenantPool(tenant.db_name);
        const result = await bulkUpdateUsers(db, {
            userIds: [userId],
            action: 'reset_password',
            newPassword
        });
        const targetUser = result.targets[0];
        // Аудит в БД колледжа (актор не из users этого колледжа -> user_id = null, контекст в details).
        await logAction(db, null, 'SUPPORT_RESET_PASSWORD', 'user', parseInt(userId), {
            bySuperAdmin: req.user.id, superAdminName: req.user.fullName, username: targetUser.username
        });
        res.json({ message: `Пароль пользователя «${targetUser.username}» сброшен` });
    } catch (error) {
        console.error('Ошибка сброса пароля (поддержка):', error);
        res.status(500).json({ error: 'Ошибка сброса пароля' });
    }
});

// ============================================
// ГЛАВНАЯ СТРАНИЦА
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/student', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/survey/:college/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'anonymous.html'));
});

app.get('/platform', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'platform.html'));
});

app.get('/curator', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'curator.html'));
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Запрос превышает допустимый размер' });
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ error: 'Некорректный JSON' });
    }
    console.error('Необработанная ошибка запроса:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
});

// Запуск сервера только после успешной инициализации всех БД и схем.
async function startServer() {
    try {
        await initializeApplication();
        return app.listen(PORT, () => {
            console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║       Система психологической диагностики студентов       ║
║                                                           ║
║   Сервер запущен: http://localhost:${PORT}                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
        });
    } catch (error) {
        console.error(' Критическая ошибка запуска:', error.message);
        process.exitCode = 1;
        return null;
    }
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer,
    initializeApplication,
    validateQuestionnaireAnswers,
    validateAnonymousAnswers,
    fallbackQuestionnaireScore,
    deriveResultMetadata,
    validateDatabasePassword,
    callLlm,
    buildScoredSummary,
    buildResultPrompt,
    buildStudentPrompt,
    buildGroupPrompt,
    studentAgeFromBirthDate
};
