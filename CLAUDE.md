# Psyagent — система психологической диагностики студентов

Веб-приложение для педагога-психолога колледжа: учёт студентов, опросники/тесты,
прохождение диагностики, статистика и экспорт.

## Стек
- **Backend:** Node.js + Express (`server.js`, единый файл).
- **БД:** MySQL 8 через `mysql2/promise` (пул соединений).
- **Auth:** JWT (`jsonwebtoken`) + `bcryptjs` для паролей.
- **Frontend:** статические HTML на Bootstrap 5 в `public/` (без сборки).

## Структура
- `server.js` — весь REST API и отдача страниц.
- `schema.sql` — создание БД `psych_diagnostic`, таблиц, индексов, пользователя БД и админа.
- `public/index.html` — вход. `admin.html` — кабинет психолога. `student.html` — кабинет студента.
- `public/styles.css` — общие стили (на него ссылаются все три страницы — имя именно `styles.css`).
- `public/i18n.js` — двуязычие RU/KZ. Текст тегается `data-i18n` / `data-i18n-ph` / `data-i18n-html`,
  динамика — через глобальную `t('ключ')`. Кнопка-переключатель вызывает `toggleLang()`;
  страница может определить `window.onLangChange` для перерисовки динамических частей.
- `public/methodologies.js` — движок и встроенный справочник методик. `window.PSY_METHODOLOGIES` —
  встроенные методики; `window.CUSTOM_METHODOLOGIES` — пользовательские (грузятся из БД через
  `registerMethodologies`); `allMethodologies()` объединяет оба. Подсчёт — `scoreMethodology(meth, answers)`:
  поддерживает подшкалы (`scales[]`), обратные вопросы (`reverse`), шкалы достоверности (`validity[]`);
  одношкальный случай (строки-вопросы + `interpretation`) — обратно совместим. Хелперы:
  `findMethodologyByTitle/ById`, `interpretMethodology`.
- **Пользовательские методики (SaaS):** хранятся в БД (таблица `methodologies`, JSON-поле `data`;
  создаётся автоматически при старте через `ensureSchema()`). CRUD — `/api/methodologies`
  (чтение — любой авторизованный, запись — админ). Редактор — раздел «Методики» в `admin.html`
  (подшкалы, интерпретация, обратные вопросы, шкалы достоверности). Выбор методики (встроенной или
  своей) — в модалке создания теста.

## Возможности (фронтенд)
- Импорт студентов из Excel (страница «Студенты»): парсинг через SheetJS на клиенте →
  `POST /api/students/import`. Обязательная колонка «Логин», пустой пароль → `Collegeit2026!`.
  Кнопка «Шаблон» скачивает .xlsx с нужными колонками.
- Экспорт результатов в Excel (страница «Результаты») — SheetJS из `/api/export/json`.
- Дашборд: график Chart.js (бар по группам: студенты vs прошедшие).
- CDN-библиотеки (только в браузере): Bootstrap 5, Chart.js, SheetJS (xlsx).

## Запуск
```bash
# 1. Установить зависимости
npm install
# 2. Создать БД и пользователя (от имени root в MySQL):
#    mysql -u root -p < schema.sql
# 3. Запустить сервер
npm start            # node server.js, порт 3000
```
Открыть http://localhost:3000

## Доступы
- **Админ:** логин `admin`, пароль `password` (хэш в `schema.sql`).
- **Пользователь БД:** `psyagent_user` / `Ewe123123!`, база `psych_diagnostic`
  (значения по умолчанию в `server.js`; переопределяются env-переменными
  `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME`, `PORT`, `JWT_SECRET`).

## Модель данных (ключевое)
- `users` — пользователи (роль `admin`/`student`), без course/specialty.
- `student_profiles` — семья и быт студента: `family_type`, `lives_with`,
  `school`, `home_address`, `psychologist_notes`. Связь 1:1 с `users`.
- `questionnaires` + `questions` — опросники и вопросы (типы: single/multiple/scale/text).
  Для методик варианты ответа хранятся как объекты `{text, score}` в `options` (вес варианта).
- `results` — прохождения (JSON-ответы + score). `assignments` — назначения тестов.
  Подсчёт балла на сервере (`/api/results/complete`): если у вопросов взвешенные варианты —
  балл = строгая СУММА весов выбранных ответов (по формуле методики); иначе — среднее по шкалам.
- `audit_log` — аудит действий.

## Особенности / на что смотреть
- Тесты доступны всем студентам (роль `student`) без ограничений по возрасту —
  системы родительских согласий в проекте нет.
- Колонки БД приходят в snake_case (`scale_labels`, `scale_min`), а фронтенд местами
  ждёт camelCase (`scaleLabels`) — сервер при выдаче опросника конвертирует это явно.
- JSON-колонки (`answers`, `options`, `target_groups`) mysql2 парсит автоматически;
  в коде стоят защитные проверки `typeof x === 'string'` перед `JSON.parse`.
- Любые `.map()/.forEach()` по ответам API на фронте обёрнуты в `Array.isArray`.

## Язык
Проект и общение с пользователем — на русском.
