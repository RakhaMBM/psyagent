const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'unit-test-secret-0123456789abcdef0123456789';
process.env.DB_PASSWORD = 'unit-test-db-password';
process.env.SUPERADMIN_PASSWORD = 'unit-test-superadmin-password';
// Пустые значения не перезаписываются dotenv — гарантируем «ИИ выключен».
process.env.OPENWEBUI_BASE_URL = '';
process.env.OPENWEBUI_API_KEY = '';
process.env.OPENWEBUI_MODEL = '';
const {
    callLlm,
    buildScoredSummary,
    buildResultPrompt,
    buildStudentPrompt,
    buildGroupPrompt,
    studentAgeFromBirthDate
} = require('../server');

const methodology = {
    id: 'unit-test-meth',
    title: 'Тестовая методика',
    answerOptions: [{ text: 'Да', score: 1 }, { text: 'Нет', score: 0 }],
    scales: [{
        id: 'anxiety',
        name: 'Тревожность',
        maxScore: 2,
        interpretation: [
            { min: 0, max: 0, level: 'low', label: 'Низкий уровень' },
            { min: 1, max: 2, level: 'high', label: 'Высокий уровень', attention: true }
        ]
    }],
    questions: [
        { text: 'Вопрос 1', scale: 'anxiety' },
        { text: 'Вопрос 2', scale: 'anxiety' }
    ]
};

// Строка результата в том виде, как её отдаёт SQL-запрос (с ФИО, которое не должно утечь).
const resultRow = {
    id: 5,
    full_name: 'Иванов Иван',
    username: 'ivanov',
    group_name: 'ИТ-101',
    questionnaire_title: 'Тестовая методика',
    methodology_data: JSON.stringify(methodology),
    answers: JSON.stringify({ 0: 'Да', 1: 'Да' }),
    score: 2,
    completed_at: '2026-01-15T10:00:00.000Z'
};

test('buildScoredSummary считает шкалы и не содержит персональных данных', () => {
    const summary = buildScoredSummary(resultRow);
    assert.equal(summary.test, 'Тестовая методика');
    assert.equal(summary.scales.length, 1);
    assert.equal(summary.scales[0].raw, 2);
    assert.equal(summary.scales[0].level, 'high');
    assert.equal(summary.scales[0].attention, true);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes('Иванов'));
    assert.ok(!serialized.includes('ivanov'));
});

test('buildResultPrompt: system+user, русский промпт, без ФИО', () => {
    const summary = buildScoredSummary(resultRow);
    const messages = buildResultPrompt(summary, { group: 'ИТ-101', age: 17 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.match(messages[0].content, /психолог/i);
    assert.match(messages[0].content, /НЕ диагноз/);
    const serialized = JSON.stringify(messages);
    assert.ok(!serialized.includes('Иванов'));
    assert.ok(serialized.includes('Тревожность'));
});

test('buildStudentPrompt объединяет результаты без ФИО', () => {
    const summary = buildScoredSummary(resultRow);
    const messages = buildStudentPrompt({ group: 'ИТ-101', age: 17 }, [summary, summary]);
    assert.equal(messages.length, 2);
    assert.match(messages[0].content, /портрет/i);
    assert.ok(!JSON.stringify(messages).includes('Иванов'));
});

test('buildGroupPrompt анонимизирует студентов и считает агрегаты', () => {
    const summary = buildScoredSummary(resultRow);
    const students = [
        { age: 17, results: [summary] },
        { age: 18, results: [summary] }
    ];
    const messages = buildGroupPrompt('ИТ-101', students);
    const userContent = messages[1].content;
    assert.ok(userContent.includes('Студент 1'));
    assert.ok(userContent.includes('Студент 2'));
    assert.ok(!userContent.includes('Иванов'));
    const payload = JSON.parse(userContent.slice(userContent.indexOf('\n') + 1));
    assert.equal(payload.aggregates.tested_students, 2);
    assert.equal(payload.aggregates.at_risk_count, 2);
});

test('callLlm без настроек отклоняется с 503 и русским сообщением', async () => {
    await assert.rejects(
        callLlm([{ role: 'user', content: 'test' }]),
        error => error.statusCode === 503 && /не настроен/.test(error.message)
    );
});

test('studentAgeFromBirthDate корректно считает возраст и отбрасывает мусор', () => {
    assert.equal(studentAgeFromBirthDate(null), null);
    assert.equal(studentAgeFromBirthDate('not-a-date'), null);
    const seventeenYearsAgo = new Date();
    seventeenYearsAgo.setFullYear(seventeenYearsAgo.getFullYear() - 17);
    assert.equal(studentAgeFromBirthDate(seventeenYearsAgo.toISOString()), 17);
});
