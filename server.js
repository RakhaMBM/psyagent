const express = require('express');
const mysql2 = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'psych-diagnostic-secret-key-2024';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// МУЛЬТИАРЕНДНОСТЬ: отдельная БД на каждый колледж (tenant)
// ============================================
// Базовая конфигурация подключения (без конкретной БД) — переиспользуется
// для control-БД, БД по умолчанию и БД отдельных колледжей.
const baseDbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'psyagent_user',
    password: process.env.DB_PASSWORD || 'Ewe123123!',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
};

const DEFAULT_DB_NAME = process.env.DB_NAME || 'psych_diagnostic';
const CONTROL_DB_NAME = process.env.CONTROL_DB_NAME || 'psych_control';

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

// Проверка подключения + авто-создание недостающих таблиц
async function testConnection() {
    try {
        const conn = await pool.getConnection();
        console.log(' Подключение к базе данных успешно!');
        conn.release();
        await ensureSchema(pool);
        await ensureControlSchema();
    } catch (error) {
        console.error(' Ошибка подключения к БД:', error.message);
    }
}

// Создаёт control-БД (реестр колледжей и супер-админов) и наполняет значениями по умолчанию.
async function ensureControlSchema() {
    try {
        const cName = safeDbName(CONTROL_DB_NAME);
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // Колледж по умолчанию = текущая БД (чтобы существующий вход работал).
        const [tenants] = await controlPool.execute('SELECT COUNT(*) AS n FROM tenants');
        if (tenants[0].n === 0) {
            await controlPool.execute(
                'INSERT INTO tenants (code, name, db_name) VALUES (?, ?, ?)',
                ['default', 'Колледж по умолчанию', DEFAULT_DB_NAME]
            );
        }

        // Супер-админ (владелец SaaS).
        const [admins] = await controlPool.execute('SELECT COUNT(*) AS n FROM platform_admins');
        if (admins[0].n === 0) {
            const suUser = process.env.SUPERADMIN_USER || 'superadmin';
            const suPass = process.env.SUPERADMIN_PASSWORD || 'superadmin';
            const hash = await bcrypt.hash(suPass, 10);
            await controlPool.execute(
                'INSERT INTO platform_admins (username, password, full_name) VALUES (?, ?, ?)',
                [suUser, hash, 'Супер-администратор']
            );
            console.log(` Супер-админ создан: ${suUser} / ${suPass} (смените пароль!)`);
        }
        console.log(' Control-БД готова (мультиарендность).');
    } catch (e) {
        console.error('Ошибка инициализации control-БД:', e.message);
    }
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
    try {
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
    } catch (e) {
        console.error('Ошибка создания таблиц:', e.message);
    }
}
testConnection();

// ============================================
// АУТЕНТИФИКАЦИЯ И MIDDLEWARE
// ============================================

// Middleware проверки JWT токена
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Недействительный токен' });
        }
        req.user = user;
        // Все запросы пользователя идут в БД его колледжа (по умолчанию — основная БД).
        req.db = tenantPool(user.tenantDb || DEFAULT_DB_NAME);
        next();
    });
}

// Middleware проверки роли администратора
function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещён. Требуются права администратора.' });
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

// ============================================
// API РОУТЫ - АУТЕНТИФИКАЦИЯ
// ============================================

// Вход в систему
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password, college } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Укажите логин и пароль' });
        }

        // Вход супер-админа (владелец SaaS): код колледжа = "platform".
        if (String(college || '').trim().toLowerCase() === 'platform') {
            if (!controlPool) return res.status(503).json({ error: 'Control-БД недоступна' });
            const [admins] = await controlPool.execute(
                'SELECT * FROM platform_admins WHERE username = ?', [username]
            );
            if (admins.length === 0 || !(await bcrypt.compare(password, admins[0].password))) {
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }
            const sa = admins[0];
            const token = jwt.sign(
                { id: sa.id, role: 'super_admin', fullName: sa.full_name },
                JWT_SECRET, { expiresIn: '24h' }
            );
            return res.json({
                token,
                user: { id: sa.id, username: sa.username, fullName: sa.full_name, role: 'super_admin' }
            });
        }

        // Вход в конкретный колледж (пустой код → колледж по умолчанию).
        const tenant = await getTenantByCode(college);
        if (!tenant) {
            return res.status(401).json({ error: 'Колледж не найден' });
        }
        const db = tenantPool(tenant.db_name);

        const [users] = await db.execute(
            'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
            [username]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role, fullName: user.full_name, tenantDb: tenant.db_name, tenantCode: tenant.code },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

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
app.get('/api/students', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { group, search } = req.query;
        let query = `
            SELECT u.id, u.username, u.full_name, u.birth_date, u.group_name,
                   u.email, u.phone, u.created_at,
                   sp.family_type, sp.lives_with, sp.school, sp.home_address
            FROM users u
            LEFT JOIN student_profiles sp ON u.id = sp.user_id
            WHERE u.role = 'student' AND u.is_active = TRUE
        `;
        const params = [];
        
        if (group) {
            query += ' AND u.group_name = ?';
            params.push(group);
        }

        if (search) {
            query += ' AND (u.full_name LIKE ? OR u.username LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
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
        
        if (!username || !password || !full_name || !birth_date) {
            return res.status(400).json({ error: 'Заполните обязательные поля' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
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
            
            await logAction(req.db, req.user.id, 'CREATE_STUDENT', 'user', userId, { fullName: full_name });
            
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
            await conn.execute(
                `UPDATE users SET full_name = ?, birth_date = ?, group_name = ?, 
                 email = ?, phone = ?, updated_at = NOW()
                 WHERE id = ?`,
                [data.full_name, data.birth_date, data.group_name, 
                 data.email, data.phone, id]
            );
            
            // Обновляем профиль
            await conn.execute(
                `UPDATE student_profiles SET family_type = ?, lives_with = ?, 
                 school = ?, home_address = ?, updated_at = NOW()
                 WHERE user_id = ?`,
                [data.family_type, data.lives_with, data.school, data.home_address, id]
            );
            
            await logAction(req.db, req.user.id, 'UPDATE_STUDENT', 'user', parseInt(id), data);
            
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
        res.status(500).json({ error: 'Ошибка обновления' });
    }
});

// Удаление студента (мягкое)
app.delete('/api/students/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await req.db.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [req.params.id]);
        await logAction(req.db, req.user.id, 'DELETE_STUDENT', 'user', parseInt(req.params.id));
        res.json({ message: 'Студент деактивирован' });
    } catch (error) {
        console.error('Ошибка удаления:', error);
        res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// Массовый импорт студентов (данные парсятся из Excel на клиенте и приходят массивом)
app.post('/api/students/import', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { students } = req.body;
        if (!Array.isArray(students) || students.length === 0) {
            return res.status(400).json({ error: 'Нет данных для импорта' });
        }

        const DEFAULT_PASSWORD = 'Collegeit2026!';
        const VALID_FAMILY = ['full', 'single_parent', 'guardian', 'other'];
        let created = 0;
        const errors = [];

        for (let i = 0; i < students.length; i++) {
            const s = students[i] || {};
            const rowNum = i + 2; // строка в Excel (с учётом заголовка)
            const username = String(s.username || '').trim();

            if (!username) {
                errors.push(`Строка ${rowNum}: не указан логин`);
                continue;
            }

            const fullName = String(s.full_name || '').trim() || username;
            const password = String(s.password || '').trim() || DEFAULT_PASSWORD;
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
        res.json({ created, total: students.length, errors });
    } catch (error) {
        console.error('Ошибка импорта студентов:', error);
        res.status(500).json({ error: 'Ошибка импорта' });
    }
});

// ============================================
// API РОУТЫ - ПРОФИЛЬ СТУДЕНТА
// ============================================

// Получение своего профиля
app.get('/api/profile', authenticateToken, async (req, res) => {
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
app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const { family_type, lives_with, school, home_address } = req.body;
        
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
        const { title, description, questions } = req.body;
        
        if (!title || !questions || questions.length === 0) {
            return res.status(400).json({ error: 'Укажите название и вопросы' });
        }
        
        const conn = await req.db.getConnection();
        await conn.beginTransaction();
        
        try {
            const [result] = await conn.execute(
                'INSERT INTO questionnaires (title, description, created_by) VALUES (?, ?, ?)',
                [title, description, req.user.id]
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
                        q.scaleMin || 1,
                        q.scaleMax || 5,
                        JSON.stringify(q.scaleLabels || {}),
                        q.isRequired !== false,
                        i
                    ]
                );
            }
            
            await logAction(req.db, req.user.id, 'CREATE_QUESTIONNAIRE', 'questionnaire', questionnaireId, { title });
            
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
        
        const [questions] = await req.db.execute(
            'SELECT * FROM questions WHERE questionnaire_id = ? ORDER BY order_index',
            [req.params.id]
        );
        
        res.json({
            ...questionnaires[0],
            questions: questions.map(q => ({
                ...q,
                options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
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
app.get('/api/my-tests', authenticateToken, async (req, res) => {
    try {
        const [assignments] = await req.db.execute(`
            SELECT a.id as assignment_id, a.status as assignment_status, a.due_date,
                   q.id, q.title, q.description,
                   (SELECT COUNT(*) FROM questions WHERE questionnaire_id = q.id) as questions_count,
                   r.status as result_status, r.completed_at
            FROM assignments a
            JOIN questionnaires q ON a.questionnaire_id = q.id
            LEFT JOIN results r ON r.user_id = a.user_id AND r.questionnaire_id = q.id
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
    try {
        const { questionnaireId, userIds, dueDate } = req.body;
        
        if (!questionnaireId || !userIds || userIds.length === 0) {
            return res.status(400).json({ error: 'Укажите тест и студентов' });
        }
        
        for (const userId of userIds) {
            await req.db.execute(
                `INSERT IGNORE INTO assignments (questionnaire_id, user_id, assigned_by, due_date)
                 VALUES (?, ?, ?, ?)`,
                [questionnaireId, userId, req.user.id, dueDate]
            );
        }
        
        await logAction(req.db, req.user.id, 'ASSIGN_TEST', 'assignment', null, { 
            questionnaireId, studentsCount: userIds.length 
        });
        
        res.json({ message: `Тест назначен ${userIds.length} студентам` });
    } catch (error) {
        console.error('Ошибка назначения:', error);
        res.status(500).json({ error: 'Ошибка назначения' });
    }
});

// ============================================
// API РОУТЫ - ПРОХОЖДЕНИЕ ТЕСТОВ
// ============================================

// Начало прохождения теста
app.post('/api/results/start', authenticateToken, async (req, res) => {
    try {
        const { questionnaireId } = req.body;
        
        // Проверяем, не проходил ли уже
        const [existing] = await req.db.execute(
            `SELECT id FROM results 
             WHERE user_id = ? AND questionnaire_id = ? AND status = 'in_progress'`,
            [req.user.id, questionnaireId]
        );
        
        if (existing.length > 0) {
            return res.json({ resultId: existing[0].id, message: 'Продолжение теста' });
        }
        
        const [result] = await req.db.execute(
            `INSERT INTO results (user_id, questionnaire_id, answers, status)
             VALUES (?, ?, '{}', 'in_progress')`,
            [req.user.id, questionnaireId]
        );
        
        // Обновляем статус назначения
        await req.db.execute(
            `UPDATE assignments SET status = 'started' 
             WHERE user_id = ? AND questionnaire_id = ? AND status = 'assigned'`,
            [req.user.id, questionnaireId]
        );
        
        res.status(201).json({ resultId: result.insertId });
    } catch (error) {
        console.error('Ошибка начала теста:', error);
        res.status(500).json({ error: 'Ошибка начала теста' });
    }
});

// Сохранение ответов
app.post('/api/results/save', authenticateToken, async (req, res) => {
    try {
        const { resultId, answers } = req.body;
        
        // Проверяем принадлежность результата
        const [results] = await req.db.execute(
            'SELECT * FROM results WHERE id = ? AND user_id = ?',
            [resultId, req.user.id]
        );
        
        if (results.length === 0) {
            return res.status(404).json({ error: 'Результат не найден' });
        }
        
        await req.db.execute(
            'UPDATE results SET answers = ? WHERE id = ?',
            [JSON.stringify(answers), resultId]
        );
        
        res.json({ message: 'Ответы сохранены' });
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

// Завершение теста
app.post('/api/results/complete', authenticateToken, async (req, res) => {
    try {
        const { resultId, answers } = req.body;
        
        const [results] = await req.db.execute(
            'SELECT * FROM results WHERE id = ? AND user_id = ?',
            [resultId, req.user.id]
        );
        
        if (results.length === 0) {
            return res.status(404).json({ error: 'Результат не найден' });
        }

        // Загружаем вопросы опросника, чтобы определить способ подсчёта
        const [questionRows] = await req.db.execute(
            'SELECT options, order_index FROM questions WHERE questionnaire_id = ? ORDER BY order_index',
            [results[0].questionnaire_id]
        );
        const questions = questionRows.map(q => ({
            options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options
        }));

        // Методика со взвешенными вариантами: вариант ответа = { text, score }.
        // Тогда балл = строгая СУММА весов выбранных вариантов (по формуле методики).
        const isWeighted = questions.some(q =>
            Array.isArray(q.options) &&
            q.options.some(o => o && typeof o === 'object' && typeof o.score === 'number')
        );

        let finalScore;
        if (isWeighted) {
            let sum = 0;
            questions.forEach((q, idx) => {
                const answer = answers ? answers[idx] : undefined;
                if (Array.isArray(q.options)) {
                    const opt = q.options.find(o =>
                        (o && typeof o === 'object' ? o.text : o) === answer
                    );
                    if (opt && typeof opt.score === 'number') sum += opt.score;
                }
            });
            finalScore = sum;
        } else {
            // Прежняя логика: среднее по числовым ответам (шкалы)
            let totalScore = 0;
            let answeredCount = 0;
            Object.values(answers || {}).forEach(answer => {
                if (typeof answer === 'number') {
                    totalScore += answer;
                    answeredCount++;
                }
            });
            finalScore = answeredCount > 0 ? Number((totalScore / answeredCount).toFixed(2)) : 0;
        }

        await req.db.execute(
            `UPDATE results SET answers = ?, score = ?, status = 'completed', completed_at = NOW()
             WHERE id = ?`,
            [JSON.stringify(answers), finalScore, resultId]
        );
        
        // Обновляем статусы
        await req.db.execute(
            `UPDATE assignments SET status = 'completed' 
             WHERE user_id = ? AND questionnaire_id = ?`,
            [req.user.id, results[0].questionnaire_id]
        );
        
        await logAction(req.db, req.user.id, 'COMPLETE_TEST', 'result', resultId, { score: finalScore });

        res.json({ message: 'Тест завершён', score: finalScore });
    } catch (error) {
        console.error('Ошибка завершения:', error);
        res.status(500).json({ error: 'Ошибка завершения' });
    }
});

// ============================================
// API РОУТЫ - РЕЗУЛЬТАТЫ (ДЛЯ АДМИНА)
// ============================================

// Получение всех результатов
app.get('/api/results', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { groupId, questionnaireId, startDate, endDate } = req.query;
        
        let query = `
            SELECT r.id, r.score, r.status, r.completed_at, r.answers,
                   u.id as user_id, u.full_name, u.group_name,
                   q.title as questionnaire_title
            FROM results r
            JOIN users u ON r.user_id = u.id
            JOIN questionnaires q ON r.questionnaire_id = q.id
            WHERE 1=1
        `;
        const params = [];
        
        if (groupId) {
            query += ' AND u.group_name = ?';
            params.push(groupId);
        }
        if (questionnaireId) {
            query += ' AND r.questionnaire_id = ?';
            params.push(parseInt(questionnaireId));
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
        
        // Парсим JSON ответы
        const parsedResults = results.map(r => ({
            ...r,
            answers: typeof r.answers === 'string' ? JSON.parse(r.answers) : r.answers
        }));
        
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
// API РОУТЫ - ПОЛЬЗОВАТЕЛЬСКИЕ МЕТОДИКИ (БД)
// ============================================

// Список методик (любой авторизованный — нужно студентам для подсчёта по формуле)
app.get('/api/methodologies', authenticateToken, async (req, res) => {
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
        await req.db.execute(
            'UPDATE methodologies SET title = ?, data = ?, updated_at = NOW() WHERE id = ?',
            [data.title, JSON.stringify(data), req.params.id]
        );
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
        await req.db.execute('DELETE FROM methodologies WHERE id = ?', [req.params.id]);
        await logAction(req.db, req.user.id, 'DELETE_METHODOLOGY', 'methodology', parseInt(req.params.id));
        res.json({ message: 'Методика удалена' });
    } catch (error) {
        console.error('Ошибка удаления методики:', error);
        res.status(500).json({ error: 'Ошибка удаления методики' });
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

// Запуск сервера
app.listen(PORT, () => {
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