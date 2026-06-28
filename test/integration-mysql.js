const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config({ quiet: true });

const { PSY_METHODOLOGIES } = require('../public/methodologies');
const { PSY_ANONYMOUS_SURVEYS } = require('../public/anonymous-surveys');

const projectRoot = path.resolve(__dirname, '..');
const suffix = `${Date.now()}_${process.pid}`.replace(/\D/g, '');
const dbName = `psyagent_it_${suffix}`;
const legacyDbName = `psyagent_it_legacy_${suffix}`;
const controlDbName = `psyagent_it_control_${suffix}`;
const port = 32000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const jwtSecret = 'integration-jwt-secret-0123456789abcdef';
const superadminPassword = 'IntegrationSuperadmin-2026';
const adminPassword = 'IntegrationAdmin-2026';
const studentPassword = 'IntegrationStudent-2026';
const legacyAdminPassword = 'IntegrationLegacy-2026';
const defaultStudentPassword = 'IntegrationDefaultStudent-2026';
const disposableTenantCode = `itdel_${suffix}`.slice(0, 50);
const disposableTenantDb = `psyagent_it_t_${disposableTenantCode}`;

const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'psyagent_user',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4'
};

let adminConnection;
let serverProcess;
let serverOutput = '';

function quoteIdentifier(value) {
    assert.match(value, /^[a-zA-Z0-9_]+$/);
    return `\`${value}\``;
}

async function request(pathname, options = {}, expectedStatus = 200) {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${baseUrl}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch (_) {
            body = text;
        }
    }
    assert.equal(
        response.status,
        expectedStatus,
        `${options.method || 'GET'} ${pathname}: ожидался ${expectedStatus}, получен ${response.status}: ${text}`
    );
    return body;
}

async function waitForServer(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (serverProcess.exitCode !== null) {
            throw new Error(`Тестовый сервер завершился преждевременно:\n${serverOutput}`);
        }
        try {
            const response = await fetch(`${baseUrl}/`);
            if (response.status === 200) return;
        } catch (_) {
            // Сервер ещё запускается.
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Тестовый сервер не запустился за ${timeoutMs} мс:\n${serverOutput}`);
}

function startServer() {
    serverOutput = '';
    serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            DB_NAME: dbName,
            CONTROL_DB_NAME: controlDbName,
            JWT_SECRET: jwtSecret,
            SUPERADMIN_USER: 'integration_superadmin',
            SUPERADMIN_PASSWORD: superadminPassword,
            DEFAULT_STUDENT_PASSWORD: defaultStudentPassword,
            TENANT_DB_PREFIX: 'psyagent_it_t_'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', chunk => {
        serverOutput += chunk.toString();
    });
    serverProcess.stderr.on('data', chunk => {
        serverOutput += chunk.toString();
    });
}

async function stopServer() {
    if (!serverProcess || serverProcess.exitCode !== null) return;
    const child = serverProcess;
    await new Promise(resolve => {
        const timeout = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, 5000);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function prepareDatabases() {
    adminConnection = await mysql.createConnection(dbConfig);
    for (const name of [dbName, legacyDbName, controlDbName]) {
        await adminConnection.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
        await adminConnection.query(
            `CREATE DATABASE ${quoteIdentifier(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
    }

    const control = await mysql.createConnection({ ...dbConfig, database: controlDbName });
    await control.query(`
        CREATE TABLE tenants (
            id INT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(60) UNIQUE NOT NULL,
            name VARCHAR(255) NOT NULL,
            db_name VARCHAR(120) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await control.execute(
        'INSERT INTO tenants (code, name, db_name) VALUES (?, ?, ?), (?, ?, ?)',
        ['default', 'Интеграционный колледж', dbName, 'legacy', 'Старая схема', legacyDbName]
    );
    await control.end();

    const legacy = await mysql.createConnection({ ...dbConfig, database: legacyDbName });
    await legacy.query(`
        CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            full_name VARCHAR(255) NOT NULL,
            role ENUM('admin','curator','student') NOT NULL DEFAULT 'student',
            birth_date DATE,
            group_name VARCHAR(100),
            email VARCHAR(150),
            phone VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            is_active BOOLEAN DEFAULT TRUE,
            KEY idx_users_role (role),
            KEY idx_users_group (group_name)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await legacy.query(`
        CREATE TABLE questionnaires (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            created_by INT NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            target_groups JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await legacy.query(`
        CREATE TABLE assignments (
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
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await legacy.query(`
        CREATE TABLE results (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            questionnaire_id INT NOT NULL,
            answers JSON NOT NULL,
            score DECIMAL(10,2),
            status ENUM('in_progress','completed') DEFAULT 'in_progress',
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id) ON DELETE CASCADE,
            KEY idx_results_user (user_id),
            KEY idx_results_questionnaire (questionnaire_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await legacy.end();
}

async function insertTenantUser(database, user) {
    const db = await mysql.createConnection({ ...dbConfig, database });
    const passwordHash = await bcrypt.hash(user.password, 4);
    const [result] = await db.execute(
        `INSERT INTO users (username, password, full_name, role, group_name)
         VALUES (?, ?, ?, ?, ?)`,
        [user.username, passwordHash, user.fullName, user.role, user.groupName || null]
    );
    await db.end();
    return result.insertId;
}

function questionnairePayload(methodology) {
    return {
        title: methodology.title,
        description: methodology.description || '',
        methodology,
        questions: methodology.questions.map(question => ({
            questionText: typeof question === 'object' ? question.text : question,
            questionType: 'single',
            options: typeof question === 'object' && question.options
                ? question.options
                : methodology.answerOptions,
            isRequired: true
        }))
    };
}

async function verifyLegacyMigration() {
    const db = await mysql.createConnection({ ...dbConfig, database: legacyDbName });
    const [userColumns] = await db.query("SHOW COLUMNS FROM users LIKE 'token_version'");
    const [questionnaireColumns] = await db.query("SHOW COLUMNS FROM questionnaires LIKE 'methodology_data'");
    const [resultColumns] = await db.query("SHOW COLUMNS FROM results LIKE 'assignment_id'");
    const [indexes] = await db.query("SHOW INDEX FROM results WHERE Key_name = 'uq_results_assignment'");
    const [foreignKeys] = await db.execute(
        `SELECT CONSTRAINT_NAME
         FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'results'
           AND REFERENCED_TABLE_NAME = 'assignments'`,
        [legacyDbName]
    );
    const [anonymousTables] = await db.execute(
        `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('anonymous_campaigns', 'anonymous_responses')`,
        [legacyDbName]
    );
    const [anonymousColumns] = await db.execute(
        `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'anonymous_responses'`,
        [legacyDbName]
    );
    assert.equal(userColumns.length, 1, 'миграция должна добавить users.token_version');
    assert.equal(questionnaireColumns.length, 1, 'миграция должна добавить questionnaires.methodology_data');
    assert.equal(resultColumns.length, 1, 'миграция должна добавить results.assignment_id');
    assert.ok(indexes.some(index => Number(index.Non_unique) === 0), 'assignment_id должен быть уникальным');
    assert.equal(foreignKeys.length, 1, 'results.assignment_id должен ссылаться на assignments');
    assert.equal(anonymousTables.length, 2, 'миграция должна добавить таблицы анонимных опросов');
    assert.ok(
        anonymousColumns.every(column => !['user_id', 'ip_address', 'full_name', 'username'].includes(column.COLUMN_NAME)),
        'обезличенные ответы не должны содержать идентификаторы респондента'
    );
    await db.end();
}

async function runScenario() {
    await prepareDatabases();
    startServer();
    await waitForServer();
    assert.match(serverOutput, /Схемы колледжей синхронизированы \(2\)/);

    await verifyLegacyMigration();

    await insertTenantUser(dbName, {
        username: 'integration_admin',
        password: adminPassword,
        fullName: 'Интеграционный психолог',
        role: 'admin'
    });
    await insertTenantUser(legacyDbName, {
        username: 'legacy_admin',
        password: legacyAdminPassword,
        fullName: 'Психолог старой схемы',
        role: 'admin'
    });

    await request('/api/students', {}, 401);
    await request('/api/results', {}, 401);
    await request('/api/platform/tenants', {}, 401);

    const adminLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'integration_admin', password: adminPassword, college: 'default' }
    });
    assert.equal(adminLogin.user.role, 'admin');
    const adminToken = adminLogin.token;

    const superadminLogin = await request('/api/auth/login', {
        method: 'POST',
        body: {
            username: 'integration_superadmin',
            password: superadminPassword,
            college: 'platform'
        }
    });
    const tenants = await request('/api/platform/tenants', { token: superadminLogin.token });
    assert.equal(tenants.length, 2);

    const disposableTenant = await request('/api/platform/tenants', {
        method: 'POST',
        token: superadminLogin.token,
        body: {
            code: disposableTenantCode,
            name: 'Колледж для удаления',
            adminUsername: 'delete_admin',
            adminPassword,
            adminFullName: 'Удаляемый администратор'
        }
    }, 201);
    assert.equal(disposableTenant.db_name, disposableTenantDb);
    const tenantsWithDisposable = await request('/api/platform/tenants', { token: superadminLogin.token });
    const disposableTenantRow = tenantsWithDisposable.find(item => item.code === disposableTenantCode);
    assert.ok(disposableTenantRow);
    await request(`/api/platform/tenants/${disposableTenantRow.id}`, {
        method: 'DELETE',
        token: superadminLogin.token,
        body: { confirmCode: 'wrong-code' }
    }, 400);
    await request(`/api/platform/tenants/${disposableTenantRow.id}`, {
        method: 'DELETE',
        token: superadminLogin.token,
        body: { confirmCode: disposableTenantCode }
    });
    const [deletedDatabases] = await adminConnection.query('SHOW DATABASES LIKE ?', [disposableTenantDb]);
    assert.equal(deletedDatabases.length, 0, 'удаление колледжа должно удалить отдельную БД');

    const student = await request('/api/students', {
        method: 'POST',
        token: adminToken,
        body: {
            username: 'integration_student',
            password: studentPassword,
            full_name: 'Тестовый Студент',
            birth_date: '2007-02-03',
            group_name: 'ИТ-101',
            family_type: 'full',
            lives_with: 'Семья',
            school: 'Тестовая школа',
            home_address: 'Тестовый адрес'
        }
    }, 201);

    const defaultPasswordStudent = await request('/api/students', {
        method: 'POST',
        token: adminToken,
        body: {
            username: 'default_password_student',
            full_name: 'Студент с паролем по умолчанию',
            birth_date: '2007-02-04',
            group_name: 'ИТ-101',
            family_type: 'full'
        }
    }, 201);
    assert.ok(defaultPasswordStudent.userId);
    const defaultPasswordLogin = await request('/api/auth/login', {
        method: 'POST',
        body: {
            username: 'default_password_student',
            password: defaultStudentPassword,
            college: 'default'
        }
    });
    assert.equal(defaultPasswordLogin.user.role, 'student');

    const anonymousTemplate = PSY_ANONYMOUS_SURVEYS[0];
    const anonymousCampaign = await request('/api/anonymous-campaigns', {
        method: 'POST',
        token: adminToken,
        body: {
            surveyKey: anonymousTemplate.id,
            targetGroup: 'ИТ-101'
        }
    }, 201);
    const anonymousPublic = await request(
        anonymousCampaign.public_path.replace('/survey/', '/api/anonymous-surveys/')
    );
    assert.equal(anonymousPublic.survey.questions.length, 7);
    const anonymousAnswers = Object.fromEntries(
        anonymousTemplate.questions.map(question => [question.id, question.options[0]])
    );
    await request(
        anonymousCampaign.public_path.replace('/survey/', '/api/anonymous-surveys/') + '/responses',
        { method: 'POST', body: { answers: anonymousAnswers } },
        201
    );
    const anonymousReport = await request(
        `/api/anonymous-campaigns/${anonymousCampaign.id}/report`,
        { token: adminToken }
    );
    assert.equal(anonymousReport.response_count, 1);
    assert.equal(anonymousReport.questions[0].options[0].count, 1);

    const questionnaires = new Map();
    for (const methodology of PSY_METHODOLOGIES) {
        const created = await request('/api/questionnaires', {
            method: 'POST',
            token: adminToken,
            body: questionnairePayload(methodology)
        }, 201);
        questionnaires.set(methodology.id, created.id);
    }
    assert.equal(questionnaires.size, 11, 'должны создаваться все 11 встроенных методик');

    const russell = PSY_METHODOLOGIES.find(item => item.id === 'ucla-loneliness-russell');
    const questionnaireId = questionnaires.get(russell.id);
    const assignment = await request('/api/assign-test', {
        method: 'POST',
        token: adminToken,
        body: { questionnaireId, userIds: [student.userId], dueDate: '2099-12-31' }
    });
    assert.deepEqual({ assigned: assignment.assigned, skipped: assignment.skipped }, { assigned: 1, skipped: 0 });

    const duplicateAssignment = await request('/api/assign-test', {
        method: 'POST',
        token: adminToken,
        body: { questionnaireId, userIds: [student.userId], dueDate: '2099-12-31' }
    });
    assert.deepEqual(
        { assigned: duplicateAssignment.assigned, skipped: duplicateAssignment.skipped },
        { assigned: 0, skipped: 1 }
    );

    const studentLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'integration_student', password: studentPassword, college: 'default' }
    });
    const studentToken = studentLogin.token;
    await request('/api/methodologies', { token: studentToken }, 403);
    const myTests = await request('/api/my-tests', { token: studentToken });
    assert.equal(myTests.length, 1);
    const assignmentId = myTests[0].assignment_id;

    const started = await request('/api/results/start', {
        method: 'POST',
        token: studentToken,
        body: { assignmentId }
    }, 201);
    const studentQuestionnaire = await request(`/api/questionnaires/${questionnaireId}`, {
        token: studentToken
    });
    assert.equal('methodology_data' in studentQuestionnaire, false);
    assert.ok(
        studentQuestionnaire.questions.every(question =>
            question.options.every(option => typeof option === 'string')
        ),
        'студент должен получать варианты без весов'
    );
    await request('/api/results/save', {
        method: 'POST',
        token: studentToken,
        body: { resultId: started.resultId, answers: { 0: 'Часто' } }
    });
    const resumed = await request('/api/results/start', {
        method: 'POST',
        token: studentToken,
        body: { assignmentId }
    });
    assert.equal(resumed.answers['0'], 'Часто');

    const answers = Object.fromEntries(russell.questions.map((_, index) => [index, 'Часто']));
    const completed = await request('/api/results/complete', {
        method: 'POST',
        token: studentToken,
        body: { resultId: started.resultId, answers }
    });
    assert.deepEqual(completed, { message: 'Тест завершён' });
    await request('/api/results/complete', {
        method: 'POST',
        token: studentToken,
        body: { resultId: started.resultId, answers }
    }, 409);

    const filteredResults = await request(
        `/api/results?groupId=${encodeURIComponent('ИТ-101')}&search=${encodeURIComponent('Тестовый')}` +
        '&level=high&risk=true',
        { token: adminToken }
    );
    assert.equal(filteredResults.length, 1);
    assert.equal(filteredResults[0].at_risk, true);
    assert.equal(filteredResults[0].interpretation_level, 'high');

    const repeatedAssignment = await request('/api/assign-test', {
        method: 'POST',
        token: adminToken,
        body: { questionnaireId, userIds: [student.userId], dueDate: '2099-12-31' }
    });
    assert.equal(repeatedAssignment.assigned, 1);

    const legacyLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'legacy_admin', password: legacyAdminPassword, college: 'legacy' }
    });
    const legacyStudents = await request('/api/students', { token: legacyLogin.token });
    assert.deepEqual(legacyStudents, [], 'данные колледжа по умолчанию не должны попадать в legacy tenant');
    await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'integration_admin', password: adminPassword, college: 'legacy' }
    }, 401);

    await stopServer();
    startServer();
    await waitForServer();
    const relogin = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'integration_admin', password: adminPassword, college: 'default' }
    });
    assert.equal(relogin.user.role, 'admin', 'повторный запуск и миграции должны быть идемпотентны');
}

async function cleanup() {
    await stopServer();
    if (!adminConnection) return;
    for (const name of [disposableTenantDb, controlDbName, legacyDbName, dbName]) {
        try {
            await adminConnection.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
        } catch (error) {
            console.error(`Не удалось удалить временную БД ${name}: ${error.message}`);
        }
    }
    await adminConnection.end();
}

(async () => {
    try {
        await runScenario();
        console.log(`Интеграционный прогон MySQL успешно завершён: ${PSY_METHODOLOGIES.length} методик.`);
    } catch (error) {
        console.error(error.stack || error);
        if (serverOutput) console.error(`\nЖурнал тестового сервера:\n${serverOutput}`);
        process.exitCode = 1;
    } finally {
        await cleanup();
        // Node fetch может удерживать keep-alive handles после остановки тестового сервера.
        // Все БД и дочерний процесс уже закрыты, поэтому завершаем прогон детерминированно.
        setImmediate(() => process.exit(process.exitCode || 0));
    }
})();
