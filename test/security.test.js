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
});

test('страницы не содержат inline-JavaScript и inline-обработчиков событий', () => {
    for (const name of ['index', 'admin', 'student', 'curator', 'platform']) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
        const script = fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.js`), 'utf8');
        assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name}.html: inline-script`);
        assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${name}.html: inline-обработчик`);
        assert.doesNotMatch(script, /\son[a-z]+\s*=/i, `${name}.js: inline-обработчик в шаблоне`);
        assert.match(source, new RegExp(`<script src="${name}\\.js"></script>`));
    }
});

test('CSP запрещает inline-скрипты и обработчики', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.doesNotMatch(source, /script-src[^;]*'unsafe-inline'/);
    assert.match(source, /script-src-attr 'none'/);
});
