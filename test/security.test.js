const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('общий HTML-экранировщик нейтрализует теги и атрибуты', () => {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'public', 'common.js'), 'utf8'),
        context
    );
    assert.equal(
        context.window.escapeHtml(`<img src=x onerror="alert('x')">`),
        '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;'
    );
});

test('кабинет администратора экранирует ответы и данные профиля', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    assert.match(source, /esc\(Array\.isArray\(val\) \? val\.join\(', '\) : val\)/);
    assert.match(source, /esc\(s\.school \|\| '-'\)/);
    assert.doesNotMatch(source, /openResetStudentPassword\([^)]*,\s*['"]/);
    assert.match(source, /i\.attention \? 'bg-danger'/);
    assert.doesNotMatch(source, /i\.level === 'high' \? 'bg-danger'/);
});

test('кабинет студента не вставляет вопросы и варианты без экранирования', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'student.js'), 'utf8');
    assert.match(source, /esc\(q\.question_text\)/);
    assert.match(source, /esc\(optLabel\(opt\)\)/);
    assert.doesNotMatch(source, /scoreMethodology|your_result|data\.score/);
    assert.match(source, /msg\.results_hidden/);
});

test('страницы не содержат inline-JavaScript и inline-обработчиков событий', () => {
    for (const name of ['index', 'admin', 'student', 'curator', 'platform', 'anonymous']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
        const script = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.js`), 'utf8');
        assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name}.html: inline-script`);
        assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${name}.html: inline-обработчик`);
        assert.doesNotMatch(script, /\son[a-z]+\s*=/i, `${name}.js: inline-обработчик в шаблоне`);
        assert.match(source, new RegExp(`<script src="/?${name}\\.js"></script>`));
    }
});

test('студенту не отдаются формула методики и веса вариантов', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /delete questionnaire\.methodology_data/);
    assert.match(source, /options\.map\(optionText\)/);
    assert.match(source, /app\.get\('\/api\/methodologies', authenticateToken, requireStaff/);
    assert.match(source, /res\.json\(\{ message: 'Тест завершён' \}\)/);
});

test('анонимные ответы не связываются с пользователями и IP', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const table = source.match(/CREATE TABLE IF NOT EXISTS anonymous_responses \(([\s\S]*?)\) CHARACTER SET/);
    assert.ok(table);
    assert.doesNotMatch(table[1], /user_id|ip_address|username|full_name/i);
});

test('CSP запрещает inline-скрипты и обработчики', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.doesNotMatch(source, /script-src[^;]*'unsafe-inline'/);
    assert.match(source, /script-src-attr 'none'/);
});

test('выборочные операции с пользователями сохраняют границы колледжа и ролей', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    const adminScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    const platform = fs.readFileSync(path.join(__dirname, '..', 'public', 'platform.js'), 'utf8');

    assert.match(server, /app\.post\('\/api\/users\/bulk', authenticateToken, requireAdmin/);
    assert.match(server, /allowedRoles: \['student', 'curator'\]/);
    assert.match(server, /app\.post\('\/api\/platform\/tenants\/:id\/users\/bulk', authenticateToken, requireSuperAdmin/);
    assert.match(server, /const db = tenantPool\(tenant\.db_name\)/);
    assert.match(admin, /id="selectAllStudents"/);
    assert.match(admin, /id="selectAllCurators"/);
    assert.match(adminScript, /data-user-select="student"/);
    assert.match(adminScript, /data-user-select="curator"/);
    assert.match(platform, /tenant\.is_active \? 'Отключить' : 'Включить'/);
    assert.match(platform, /data-action="deleteTenant"/);
});
