const test = require('node:test');
const assert = require('node:assert/strict');
const { PSY_ANONYMOUS_SURVEYS } = require('../public/anonymous-surveys');

test('встроены две отдельные анонимные анкеты из сборника', () => {
    assert.deepEqual(
        PSY_ANONYMOUS_SURVEYS.map(survey => [survey.id, survey.questions.length]),
        [['treatment-2-4', 7], ['treatment-5-11', 10]]
    );
});

test('анонимные анкеты не содержат балльного ключа и персональных полей', () => {
    for (const survey of PSY_ANONYMOUS_SURVEYS) {
        assert.ok(survey.questions.every(question => Array.isArray(question.options)));
        assert.ok(survey.questions.every(question =>
            question.options.every(option => typeof option === 'string')
        ));
        assert.doesNotMatch(JSON.stringify(survey), /user_id|full_name|username|score/i);
    }
});

test('условный вопрос о субъекте насилия не обязателен при отсутствии случая', () => {
    const survey = PSY_ANONYMOUS_SURVEYS.find(item => item.id === 'treatment-5-11');
    const question = survey.questions.find(item => item.id === 'q9');
    assert.deepEqual(question.showWhen, {
        questionId: 'q8',
        notEquals: 'Не сталкивался(-ась).'
    });
});
