const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PSY_METHODOLOGIES,
    scoreMethodology
} = require('../public/methodologies');

test('встроенный справочник содержит одиннадцать методик с уникальными id', () => {
    assert.equal(PSY_METHODOLOGIES.length, 11);
    assert.equal(new Set(PSY_METHODOLOGIES.map(item => item.id)).size, 11);
});

test('шкала Корчагиной считает нижнюю и верхнюю границы', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'loneliness-experience-korchagina');
    const maximum = Object.fromEntries(
        methodology.questions.map((_, index) => [index, methodology.answerOptions[0].text])
    );
    const minimum = Object.fromEntries(
        methodology.questions.map((_, index) => [index, methodology.answerOptions[3].text])
    );

    assert.equal(scoreMethodology(methodology, maximum).total, 48);
    assert.equal(scoreMethodology(methodology, minimum).total, 12);
});

test('методика Хмельницкой учитывает обратные пункты', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'anxiety-5th-grade-khmelnitskaya');
    const maximum = {};
    const minimum = {};

    methodology.questions.forEach((question, index) => {
        const reverse = question && typeof question === 'object' && question.reverse;
        maximum[index] = methodology.answerOptions[reverse ? 1 : 0].text;
        minimum[index] = methodology.answerOptions[reverse ? 0 : 1].text;
    });

    assert.equal(scoreMethodology(methodology, maximum).total, 15);
    assert.equal(scoreMethodology(methodology, minimum).total, 0);
});

test('тест Мадди считает три субшкалы и общий показатель без удвоения', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'hardiness-maddi');
    const maximum = {};

    methodology.questions.forEach((question, index) => {
        maximum[index] = methodology.answerOptions[question.reverse ? 0 : 3].text;
    });

    const result = scoreMethodology(methodology, maximum);
    const rawByScale = Object.fromEntries(result.scales.map(scale => [scale.id, scale.raw]));

    assert.equal(result.total, 135);
    assert.equal(rawByScale.total, 135);
    assert.equal(rawByScale.involvement, 54);
    assert.equal(rawByScale.control, 51);
    assert.equal(rawByScale.risk, 30);
});

test('шкала Янг считает заявленные границы 20 и 100 баллов', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'internet-addiction-young');
    const minimum = Object.fromEntries(methodology.questions.map((_, index) => [index, 'Никогда']));
    const maximum = Object.fromEntries(methodology.questions.map((_, index) => [index, 'Постоянно']));

    assert.equal(scoreMethodology(methodology, minimum).total, 20);
    assert.equal(scoreMethodology(methodology, maximum).total, 100);
});

test('опросник Олвеуса считает средние по пересекающимся шкалам', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'bullying-olweus');
    const answers = Object.fromEntries(
        methodology.questions.map((_, index) => [index, 'Бывает несколько раз в неделю'])
    );
    const result = scoreMethodology(methodology, answers);

    assert.equal(result.total, 4);
    assert.equal(result.scales.length, 6);
    result.scales.forEach(scale => {
        assert.equal(scale.raw, 4);
        assert.equal(scale.interp.level, 'high');
    });
});

test('шкала благополучия учитывает положительные и обратные утверждения', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'adolescent-wellbeing-ryff');
    const maximum = {};
    const minimum = {};

    methodology.questions.forEach((question, index) => {
        const reverse = question && typeof question === 'object' && question.reverse;
        maximum[index] = methodology.answerOptions[reverse ? 2 : 0].text;
        minimum[index] = methodology.answerOptions[reverse ? 0 : 2].text;
    });

    assert.equal(scoreMethodology(methodology, maximum).total, 36);
    assert.equal(scoreMethodology(methodology, minimum).total, 0);
});

test('шкала Бека считает ключ «Верно/Неверно» и границы 0–20', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'hopelessness-beck');
    const maximum = {};
    const minimum = {};

    methodology.questions.forEach((question, index) => {
        const reverse = question && typeof question === 'object' && question.reverse;
        maximum[index] = reverse ? 'Неверно' : 'Верно';
        minimum[index] = reverse ? 'Верно' : 'Неверно';
    });

    assert.equal(scoreMethodology(methodology, maximum).total, 20);
    assert.equal(scoreMethodology(methodology, minimum).total, 0);
});

test('шкала Кука—Медли считает три независимых показателя', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'hostility-cook-medley');
    const answers = Object.fromEntries(methodology.questions.map((_, index) => [index, 'Обычно']));
    const result = scoreMethodology(methodology, answers);
    const values = Object.fromEntries(result.scales.map(scale => [scale.id, scale.raw]));

    assert.equal(result.total, 78);
    assert.deepEqual(values, { cynicism: 78, aggressiveness: 54, hostility: 30 });
});

test('шкала Розенберга сохраняет отдельные факторы без взаимного погашения', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'self-esteem-rosenberg');
    const answers = Object.fromEntries(methodology.questions.map((_, index) => [index, 'Полностью согласен']));
    const result = scoreMethodology(methodology, answers);
    const values = Object.fromEntries(result.scales.map(scale => [scale.id, scale.raw]));

    assert.equal(result.total, 10);
    assert.deepEqual(values, { 'self-respect': 10, 'self-abasement': 10 });
});

test('опросник Кожухарь считает блоки, подшкалы и индексы по одному ключу', () => {
    const methodology = PSY_METHODOLOGIES.find(item => item.id === 'educational-relationships-adolescents-kozhukhar');
    const maximum = {};

    methodology.questions.forEach((question, index) => {
        maximum[index] = question.reverse ? 'Совершенно не согласен' : 'Полностью согласен';
    });

    const result = scoreMethodology(methodology, maximum);
    const values = Object.fromEntries(result.scales.map(scale => [scale.id, scale.raw]));

    assert.equal(methodology.questions.length, 48);
    assert.equal(result.total, 24);
    assert.equal(values['positive-index'], 24);
    assert.equal(values['negative-index'], 24);
    assert.equal(values.trust, 24);
    assert.equal(values['trust-adults'], 12);
    assert.equal(values['trust-students'], 12);
});

test('шкала достоверности помечает превышение порога', () => {
    const methodology = {
        answerOptions: [{ text: 'Нет', score: 0 }, { text: 'Да', score: 1 }],
        questions: [{ text: 'Контроль', scale: 'validity' }],
        scales: [{ id: 'main', name: 'Основная', interpretation: [] }],
        validity: [{ id: 'v', name: 'Контроль', scale: 'validity', threshold: 0 }]
    };
    const result = scoreMethodology(methodology, { 0: 'Да' });
    assert.equal(result.validity[0].failed, true);
});
