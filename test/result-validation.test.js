const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'unit-test-secret-0123456789abcdef0123456789';
process.env.DB_PASSWORD = 'unit-test-db-password';
process.env.SUPERADMIN_PASSWORD = 'unit-test-superadmin-password';
const {
    validateQuestionnaireAnswers,
    fallbackQuestionnaireScore,
    deriveResultMetadata
} = require('../server');

const questions = [
    {
        question_type: 'single',
        options: [{ text: 'Да', score: 2 }, { text: 'Нет', score: 0 }],
        scale_min: 1,
        scale_max: 5,
        is_required: true
    },
    {
        question_type: 'multiple',
        options: [{ text: 'A', score: 1 }, { text: 'B', score: 3 }],
        scale_min: 1,
        scale_max: 5,
        is_required: false
    },
    {
        question_type: 'scale',
        options: [],
        scale_min: 1,
        scale_max: 5,
        is_required: true
    }
];

test('валидация отклоняет пропущенный обязательный ответ', () => {
    assert.match(validateQuestionnaireAnswers(questions, { 0: 'Да' }), /обязательный вопрос №3/);
});

test('валидация отклоняет вариант, которого нет в вопросе', () => {
    assert.match(
        validateQuestionnaireAnswers(questions, { 0: 'Не знаю', 2: 3 }),
        /Недопустимый ответ/
    );
});

test('валидация принимает корректные ответы', () => {
    assert.equal(
        validateQuestionnaireAnswers(questions, { 0: 'Да', 1: ['A', 'B'], 2: 4 }),
        null
    );
});

test('резервный подсчёт суммирует веса одиночных и множественных ответов', () => {
    assert.equal(
        fallbackQuestionnaireScore(questions, { 0: 'Да', 1: ['A', 'B'], 2: 4 }),
        6
    );
});

test('метаданные результата содержат уровень и признак риска из снимка методики', () => {
    const methodology = {
        title: 'Тестовая методика',
        answerOptions: [{ text: 'Нет', score: 0 }, { text: 'Да', score: 1 }],
        questions: ['Вопрос'],
        maxScore: 1,
        interpretation: [
            { min: 0, max: 0, level: 'low', label: 'Низкий' },
            { min: 1, max: 1, level: 'high', label: 'Высокий', attention: true }
        ]
    };
    const result = deriveResultMetadata({
        questionnaire_title: methodology.title,
        methodology_data: JSON.stringify(methodology),
        answers: JSON.stringify({ 0: 'Да' })
    });

    assert.equal(result.interpretation_level, 'high');
    assert.equal(result.interpretation_label, 'Высокий');
    assert.equal(result.at_risk, true);
    assert.deepEqual(result.risk_reasons, [{ scale: 'Тестовая методика', label: 'Высокий' }]);
});
