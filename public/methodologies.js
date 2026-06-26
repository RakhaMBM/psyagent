/* ============================================
   methodologies.js — справочник психодиагностических методик
   --------------------------------------------------------------
   Чтобы ДОБАВИТЬ методику — просто добавьте объект в массив
   PSY_METHODOLOGIES по образцу ниже.

   Поля методики:
     id            — уникальный строковый ключ (латиницей)
     title         — название (используется как название теста; по нему же
                     подбирается интерпретация, поэтому менять его в самом
                     тесте не нужно)
     description   — краткое описание
     instruction   — инструкция для студента (показывается перед вопросами)
     answerOptions — варианты ответа с весами: [{ text, score }, ...].
                     Общие для всех вопросов (вопрос может переопределить своими).

     questions     — список вопросов. Поддерживаются ДВА формата:
                     • простой: массив строк (одна общая шкала, сумма весов);
                     • расширенный: массив объектов
                         { text, scale?, reverse?, options? }
                       scale   — id подшкалы, к которой относится вопрос
                                 (если не указан — попадает в первую/общую шкалу);
                       reverse — обратный вопрос: вес считается зеркально
                                 (min+max − выбранный), для прямых/обратных пунктов;
                       options — свои варианты ответа для этого вопроса (иначе берутся
                                 общие answerOptions).

   --- Одношкальная методика (как раньше) ---
     maxScore      — максимально возможный балл (подпись «из N»)
     interpretation— диапазоны: [{ min, max, level, label, color? }]

   --- Многошкальная методика (подшкалы) ---
     scales        — массив подшкал, у каждой своя интерпретация:
                     [{ id, name, maxScore?, interpretation: [{min,max,level,label,color?}] }]
     validity      — НЕОБЯЗАТЕЛЬНО: шкалы достоверности (напр. «шкала лжи»):
                     [{ id, name, scale, threshold, warning }]
                     Если сумма по шкале > threshold — результат помечается
                     как недостоверный (warning).

   Подсказки по интерпретации:
     label — текст уровня (показывается в таблице/диаграммах/отчётах).
     level — произвольный ключ. Для 'low' | 'medium' | 'high' есть стандартные
             цвета (зелёный/жёлтый/красный); любые другие значения тоже работают —
             цвет берётся из палитры автоматически.
     color — НЕОБЯЗАТЕЛЬНО: свой цвет диапазона (например '#ef476f').
     attention — НЕОБЯЗАТЕЛЬНО: true, если этот уровень — повод для внимания
                 (студент попадает в «группу риска»). Так риск задаёт сама методика.

   Любое число шкал и уровней — подсчёт (scoreMethodology) и инфографика строятся
   из этих данных и масштабируются сами. Балл считается на клиенте по этим правилам.
   ============================================ */

window.PSY_METHODOLOGIES = [
    {
        id: 'ucla-loneliness-russell',
        title: 'Методика диагностики уровня субъективного ощущения одиночества (Д. Рассел, Л. Пепло, М. Фергюсон)',
        description: 'Диагностический тест-опросник для определения уровня субъективного ощущения одиночества — насколько человек ощущает себя одиноким.',
        instruction: 'Вам предлагается ряд утверждений. Рассмотрите последовательно каждое и оцените с точки зрения частоты их проявления применительно к Вашей жизни при помощи четырёх вариантов ответов: «часто», «иногда», «редко», «никогда».',
        answerOptions: [
            { text: 'Часто', score: 3 },
            { text: 'Иногда', score: 2 },
            { text: 'Редко', score: 1 },
            { text: 'Никогда', score: 0 }
        ],
        questions: [
            'Я несчастлив, занимаясь столькими вещами в одиночку',
            'Мне не с кем поговорить',
            'Для меня невыносимо быть таким одиноким',
            'Мне не хватает общения',
            'Я чувствую, будто никто не понимает меня',
            'Я застаю себя в ожидании, что люди позвонят, напишут мне',
            'Нет никого, к кому бы я мог обратиться',
            'Я сейчас больше ни с кем не близок',
            'Те, кто меня окружает, не разделяют мои интересы и идеи',
            'Я чувствую себя покинутым',
            'Я не способен раскрепощаться и общаться с теми, кто меня окружает',
            'Я чувствую себя совершенно одиноким',
            'Мои социальные отношения и связи поверхностны',
            'Мне не достает компании',
            'В действительности никто как следует не знает меня',
            'Я чувствую себя изолированным от других',
            'Я несчастен, будучи таким отверженным',
            'Мне трудно заводить друзей',
            'Я чувствую себя исключенным и изолированным другими',
            'Люди вокруг меня, но не со мной'
        ],
        maxScore: 60,
        interpretation: [
            { min: 40, max: 60, level: 'high',   label: 'Высокая степень одиночества', attention: true },
            { min: 20, max: 40, level: 'medium', label: 'Средний уровень одиночества' },
            { min: 0,  max: 20, level: 'low',    label: 'Низкий уровень одиночества' }
        ]
    }
];

/* ---------- Хелперы (доступны глобально на всех страницах) ---------- */

// Пользовательские методики из БД (загружаются страницей через /api/methodologies).
window.CUSTOM_METHODOLOGIES = [];
window.registerMethodologies = function (arr) {
    window.CUSTOM_METHODOLOGIES = Array.isArray(arr) ? arr : [];
};

// Все методики: встроенные (этот файл) + пользовательские (из БД).
window.allMethodologies = function () {
    return [].concat(window.PSY_METHODOLOGIES || [], window.CUSTOM_METHODOLOGIES || []);
};

// Поиск методики по точному названию теста (среди встроенных и пользовательских)
window.findMethodologyByTitle = function (title) {
    if (!title) return null;
    const n = String(title).trim();
    return window.allMethodologies().find(m => String(m.title).trim() === n) || null;
};

// Поиск методики по id
window.findMethodologyById = function (id) {
    return window.allMethodologies().find(m => m.id === id) || null;
};

// Определения шкал методики. Для одношкальной — собираем единственную шкалу 'total'.
function getScaleDefs(meth) {
    if (meth && Array.isArray(meth.scales) && meth.scales.length) return meth.scales;
    return [{
        id: 'total',
        name: meth && meth.title ? meth.title : 'Итог',
        maxScore: meth ? meth.maxScore : undefined,
        interpretation: (meth && meth.interpretation) || []
    }];
}

// Приводим вопросы к единому виду: { text, scale, reverse, options }.
function normalizeQuestions(meth, defaultScaleId) {
    const list = (meth && Array.isArray(meth.questions)) ? meth.questions : [];
    const common = (meth && meth.answerOptions) || [];
    return list.map(q => {
        if (q && typeof q === 'object') {
            return {
                text: q.text || '',
                scale: q.scale || defaultScaleId,
                reverse: !!q.reverse,
                options: q.options || common
            };
        }
        return { text: String(q), scale: defaultScaleId, reverse: false, options: common };
    });
}

// Интерпретация числа по набору диапазонов -> диапазон | null
function interpretRange(ranges, score) {
    if (!Array.isArray(ranges)) return null;
    const s = Number(score);
    if (!isFinite(s)) return null;
    for (const r of ranges) {
        if (s >= r.min && s <= r.max) return r;
    }
    return null;
}

// Обратная совместимость: интерпретация по общим диапазонам методики.
window.interpretMethodology = function (meth, score) {
    return interpretRange(meth && meth.interpretation, score);
};

// Признак «методики со взвешенными вариантами» по списку вопросов опросника
window.hasWeightedOptions = function (questions) {
    return Array.isArray(questions) && questions.some(q =>
        Array.isArray(q.options) &&
        q.options.some(o => o && typeof o === 'object' && typeof o.score === 'number')
    );
};

/**
 * Полный подсчёт результата методики по ответам (единый движок).
 * answers — объект { индексВопроса: текстВыбранногоВарианта }.
 * Возвращает:
 *   {
 *     scales:   [{ id, name, raw, maxScore, interp }],  // по каждой подшкале
 *     total:    суммарный балл по всем шкалам,
 *     validity: [{ id, name, value, threshold, failed, warning }],
 *     primary:  первая (главная) шкала
 *   }
 * Учитывает: подшкалы, обратные вопросы (reverse), свои варианты у вопроса,
 * шкалы достоверности. Одношкальная методика — частный случай.
 */
window.scoreMethodology = function (meth, answers) {
    const a = answers || {};
    const scaleDefs = getScaleDefs(meth);
    const defaultScaleId = scaleDefs[0] ? scaleDefs[0].id : 'total';
    const questions = normalizeQuestions(meth, defaultScaleId);

    const sums = {};
    scaleDefs.forEach(s => { sums[s.id] = 0; });

    questions.forEach((q, idx) => {
        const ans = a[idx];
        const opts = Array.isArray(q.options) ? q.options : [];
        const opt = opts.find(o => (o && typeof o === 'object' ? o.text : o) === ans);
        if (!opt || typeof opt.score !== 'number') return;

        let sc = opt.score;
        if (q.reverse) {
            const nums = opts
                .map(o => (o && typeof o === 'object') ? o.score : null)
                .filter(n => typeof n === 'number');
            if (nums.length) {
                sc = (Math.min(...nums) + Math.max(...nums)) - sc;
            }
        }
        if (sums[q.scale] == null) sums[q.scale] = 0;
        sums[q.scale] += sc;
    });

    const scales = scaleDefs.map(s => ({
        id: s.id,
        name: s.name || s.id,
        raw: sums[s.id] || 0,
        maxScore: s.maxScore,
        interp: interpretRange(s.interpretation, sums[s.id] || 0)
    }));

    const total = scaleDefs.reduce((acc, s) => acc + (sums[s.id] || 0), 0);

    const validity = ((meth && meth.validity) || []).map(v => {
        const value = sums[v.scale] != null ? sums[v.scale] : 0;
        return {
            id: v.id,
            name: v.name,
            value,
            threshold: v.threshold,
            failed: typeof v.threshold === 'number' && value > v.threshold,
            warning: v.warning
        };
    });

    return { scales, total, validity, primary: scales[0] || null };
};

/**
 * Признак «группы риска» по результату: верно, если у какой-либо шкалы попавший
 * диапазон интерпретации отмечен флагом attention: true (это задаёт сама методика).
 * -> { atRisk: boolean, reasons: [{ scale, label }] }
 */
window.resultAttention = function (meth, answers) {
    if (!meth || typeof window.scoreMethodology !== 'function') return { atRisk: false, reasons: [] };
    const sc = window.scoreMethodology(meth, answers || {});
    const reasons = sc.scales
        .filter(s => s.interp && s.interp.attention)
        .map(s => ({ scale: s.name, label: s.interp.label }));
    return { atRisk: reasons.length > 0, reasons };
};
