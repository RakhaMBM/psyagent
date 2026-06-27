# AGENTS.md — инструкция для ИИ-агентов по проекту Psyagent

Этот файл — единая точка входа для любого ИИ (Claude, Cursor, Copilot, ChatGPT и т.п.),
который работает с проектом. Прочитай его целиком перед изменениями. Общение и комментарии — **на русском**.

---

## 1. Что это за проект

**Psyagent** — веб-приложение психологической диагностики студентов для колледжей (педагог-психолог).
Учёт студентов, опросники/методики, прохождение тестов, подсчёт по формуле с интерпретацией,
группа риска, печатные заключения, статистика, экспорт. **Мультиарендный SaaS** (один сервер —
много колледжей, у каждого своя БД).

- **Backend:** Node.js + Express — весь код в одном файле `server.js`.
- **БД:** MySQL 8 через `mysql2/promise`.
- **Auth:** JWT (`jsonwebtoken`) + `bcryptjs`. Секрет — `JWT_SECRET` (из `.env`, см. §9).
- **Frontend:** статические HTML на Bootstrap 5 в `public/` (без сборки, без фреймворков).
- Внешние библиотеки только в браузере по CDN: Bootstrap 5, Chart.js, SheetJS (xlsx).

---

## 2. Структура

| Файл | Назначение |
|---|---|
| `server.js` | Весь REST API + отдача страниц. ~1500 строк. |
| `schema.sql` | Схема БД колледжа (для чистой установки). |
| `public/index.html` | Вход (поле «код колледжа»). |
| `public/admin.html` | Кабинет психолога-админа (студенты, кураторы, тесты, методики, результаты, дашборд). |
| `public/curator.html` | Кабинет куратора (read-only по своей группе). |
| `public/student.html` | Кабинет студента (прохождение тестов). |
| `public/platform.html` | Кабинет супер-админа (`/platform`): колледжи, сброс паролей. |
| `public/i18n.js` | Двуязычие RU/KZ (см. §7). |
| `public/methodologies.js` | Движок подсчёта + встроенные методики (см. §5). |
| `public/styles.css` | Общие стили (имя именно `styles.css`). |
| `MULTITENANCY.md` | Детали мультиарендности и серверной настройки БД. |
| `CLAUDE.md` | Краткий гайд (дублирует часть этого файла). |

---

## 3. Роли и вход

Вход: `POST /api/auth/login` с телом `{ username, password, college }`.
- `college` пустой → **колледж по умолчанию** (`default` → БД `psych_diagnostic`). Старый вход не ломается.
- `college = "platform"` → вход **супер-админа** (владелец SaaS, таблица `platform_admins` в control-БД).
- иначе → колледж по коду (таблица `tenants`).

Роли и редиректы (см. `redirectByRole` в `index.html`):
- `super_admin` → `/platform` (cross-tenant, не привязан к колледжу).
- `admin` (психолог) → `/admin` (полный доступ в своём колледже).
- `curator` → `/curator` (read-only **только по своей группе**, `users.group_name`).
- `student` → `/student`.

Middleware в `server.js`: `requireAdmin`, `requireSuperAdmin`, `requireStaff` (admin|curator).

---

## 4. Мультиарендность — КРИТИЧНО

**Отдельная БД на каждый колледж.** Реестр колледжей и супер-админы — в отдельной **control-БД** `psych_control`.

- Колледж зашит в JWT (`tenantDb`). `authenticateToken` ставит `req.db = tenantPool(tenantDb)`.
- **Все маршруты данных колледжа ходят ТОЛЬКО через `req.db`.** НИКОГДА не используй глобальный `pool`
  внутри обработчиков запросов — это утечка данных между колледжами. `pool` = только БД по умолчанию.
- `controlPool` — только для `tenants` / `platform_admins`. `adminPool` (без БД) — для `CREATE DATABASE`.
- `logAction(db, userId, ...)` — первым аргументом передаётся пул колледжа (`req.db` или резолвнутый).
- При провижининге нового колледжа: `CREATE DATABASE` → `ensureTenantSchema(db)` (вся схема `IF NOT EXISTS`)
  → первый админ-психолог. При старте `syncTenantSchemas()` накатывает схему на все активные колледжи.
- **При изменении схемы** правь `ensureTenantSchema()` (а не только `schema.sql`), иначе на боевых
  БД колледжей таблицы/колонки не появятся. Для enum-миграций — идемпотентный `ALTER` в конце `ensureTenantSchema`.

Подробности и шаги настройки БД на сервере (права `CREATE DATABASE` для `psyagent_user` и т.д.) — в `MULTITENANCY.md`.

---

## 5. Движок методик (`public/methodologies.js`)

Единый подсчёт: `window.scoreMethodology(meth, answers)` → `{ scales:[{id,name,raw,maxScore,interp}], total, validity, primary }`.
- Поддерживает: **подшкалы** (`scales[]`), **обратные вопросы** (`reverse: true` — вес зеркальный
  `min+max−score`), **шкалы достоверности** (`validity[]`, напр. «шкала лжи»), свои варианты у вопроса.
- Одношкальный случай (вопросы-строки + `interpretation` + `maxScore`) — обратно совместим.
- `window.resultAttention(meth, answers)` → попал ли результат в диапазон с флагом `attention: true`
  (это и есть «группа риска» — задаётся самой методикой).
- `findMethodologyByTitle / findMethodologyById`, `allMethodologies()` (встроенные + пользовательские из БД).

**Формат методики** (объект в `window.PSY_METHODOLOGIES`):
```js
{
  id, title, description, instruction,
  answerOptions: [{ text, score }],          // общие варианты (вес)
  questions: [                                // строка ИЛИ объект:
    'Текст вопроса',
    { text, scale?, reverse?, options? }      // scale — id подшкалы; reverse — обратный
  ],
  // одношкальная:
  maxScore, interpretation: [{ min, max, level, label, color?, attention? }],
  // ИЛИ многошкальная:
  scales: [{ id, name, maxScore?, interpretation:[...] }],
  validity: [{ id, name, scale, threshold, warning }]   // необязательно
}
```
- `level`: `low`/`medium`/`high` имеют стандартные цвета; любые другие — палитра. `attention:true` → группа риска.
- **Принцип масштабирования (важно):** НЕ хардкодить логику/инфографику под одну методику.
  Всё строй из данных `methodologies.js` — любое число шкал/уровней с любыми названиями. (Историческая
  ошибка: инфографику результатов однажды зашили под одну методику — переделали на data-driven.)
- Пользовательские методики психолог создаёт в редакторе (раздел «Методики» в `admin.html`),
  хранятся в БД (таблица `methodologies`, JSON `data`), CRUD — `/api/methodologies`.

---

## 6. Как ДОБАВИТЬ методику из PDF-сборника

Источник: `СБОРНИК диагностических методик РУСС.pdf` (у пользователя; 83 стр., ~24 методики).

⚠️ **Текст из этого PDF не извлекается** (`pdftotext` даёт мусор — у шрифта нет Unicode-карты).
Поэтому страницы нужно **рендерить в картинки и читать визуально**. На этой Windows-машине нет
`pdftoppm`/ImageMagick/рабочего Python — но есть встроенный PDF-движок Windows. Скрипт (PowerShell 5.1):

```powershell
# render.ps1 -Pdf <путь> -OutDir <папка> -First <n> -Last <m>  → page_NN.png
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op,$t){ $m=$asTaskGeneric.MakeGenericMethod($t); $task=$m.Invoke($null,@($op)); $task.Wait(-1)|Out-Null; $task.Result }
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and -not $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function AwaitAction($a){ $task=$asTaskAction.Invoke($null,@($a)); $task.Wait(-1)|Out-Null }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]|Out-Null
[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]|Out-Null
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
$doc=Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$opts=New-Object Windows.Data.Pdf.PdfPageRenderOptions; $opts.DestinationWidth=[uint32]1654
for($i=$First;$i -le $Last;$i++){ $p=$doc.GetPage($i-1); $s=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($p.RenderToStreamAsync($s,$opts)); $sz=[uint32]$s.Size; $r=New-Object Windows.Storage.Streams.DataReader($s.GetInputStreamAt(0))
  Await ($r.LoadAsync($sz)) ([uint32])|Out-Null; $b=New-Object byte[] $sz; $r.ReadBytes($b)
  [IO.File]::WriteAllBytes((Join-Path $OutDir ("page_{0:D2}.png" -f $i)),$b); $p.Dispose() }
```
Затем читай PNG как изображения (Read tool / vision). Методики идут после вступления (печатные стр. ~17+).

**Процесс:** отрендерь страницы методики → прочитай вопросы, варианты-веса и ключ/нормы →
оформи объект по формату §5 → добавь в `PSY_METHODOLOGIES` → **юнит-тест подсчёта** (см. §8) →
проверь §8 → коммит. **Точность ключей критична** — это клиника; проси пользователя сверить с источником.

**Уже добавлены (встроенные):** 1.1.1 Одиночество (Рассел), 1.1.2 Одиночество (Корчагина),
1.1.3 Тревожность 5-классников (Хмельницкая).

---

## 7. i18n RU/KZ — правила

- Текст в HTML тегается `data-i18n="ключ"` (textContent), `data-i18n-ph` (placeholder), `data-i18n-html` (innerHTML).
- Динамика в JS — через глобальную `t('ключ')`. Язык переключает `toggleLang()`; страница может задать `window.onLangChange`.
- **Каждый используемый ключ ОБЯЗАН быть и в `ru`, и в `kz`** в `public/i18n.js`. Паритет проверяется (см. §8).
- `platform.html` — на русском без i18n (внутренний кабинет супер-админа), это нормально.

---

## 8. Проверка перед коммитом — ОБЯЗАТЕЛЬНО

```bash
# 1. Синтаксис
node --check server.js && node --check public/i18n.js && node --check public/methodologies.js

# 2. Синтаксис встроенных <script> в HTML + паритет i18n + нет пропущенных/лишних ключей.
#    Суть проверки: извлечь ключи ru/kz из i18n.js, собрать использованные (data-i18n* и t('...'))
#    в admin/student/index/curator.html, убедиться что нет missing и нет RU-only/KZ-only.
#    (Готовый скрипт многократно использовался — см. историю; уровни level.low/medium/high
#     используются динамически как t('level.'+x), статически могут выглядеть «unused» — это норма.)

# 3. Старт сервера (БД может быть недоступна локально — это ок, важно что слушает порт)
node server.js   # затем: curl http://localhost:3000/  -> 200

# 4. Защита эндпоинтов: новые admin/super-admin роуты без токена должны давать 401
```
Если добавлял методику — обязательно прогони юнит-тест `scoreMethodology` (граничные значения,
обратные вопросы, шкалы достоверности). Примеры тестов есть в истории коммитов.

Локально нет доступа к MySQL (часто `Access denied`/`ECONNREFUSED`) — это нормально, БД-логику
проверяет пользователь на сервере. `dotenv` должен быть в `node_modules` (если нет — `npm install`).

---

## 9. Доступы, секреты, git

- **Супер-админ:** код колледжа `platform`, логин/пароль из `.env` (`SUPERADMIN_USER`/`SUPERADMIN_PASSWORD`,
  по умолчанию `superadmin`/`superadmin` — **сменить в проде!**).
- **Психолог-админ колледжа по умолчанию:** логин `admin` (пароль задаётся/менялся).
- **БД:** `psyagent_user` / `Ewe123123!` (дефолты в `server.js`, переопределяются `.env`:
  `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME`, `CONTROL_DB_NAME`, `PORT`, `JWT_SECRET`).
- `.env` — в `.gitignore`, **в репозиторий не коммитить**. Секреты в код не вписывать.
- **Git:** ветка `main`. Перед коммитом — проверки §8. Коммиты осмысленные. Пушить в `origin main`.

---

## 10. Текущие задачи (TODO)

1. **Методики из PDF** — в работе. Готовы 3 (см. §6). Осталось оцифровать опросники из сборника:
   1.1.4 Жизнестойкость (Мадди), 1.1.6 Карта риска суицида (Шнейдер), 1.1.7 Интернет-зависимость (Янг),
   1.2.1 Буллинг (Олвеус), 1.2.3/1.2.4 «Как с тобой обращаются», 1.2.7 Благополучие (Рифф),
   1.2.8 Кибербуллинг (Ракишева), 2.1.4 Безнадёжность (Бек), 2.2.2/2.2.3 Межличностные отношения (Кожухарь),
   2.2.4 Враждебность (Кук-Медли), 2.2.5 Самооценка (Розенберг). Добавлять батчами, по §6.
   *НЕ оцифровываются (проективные/экспертные):* Дерево с человечками, Человек под дождём,
   Несуществующее животное, экспертные схемы адаптации, незаконченные предложения, таблица риска суицида.
2. **Отчётность по группам** — печатный/экранный свод по группе (студенты, прохождения,
   распределение по уровням, группа риска). Аналогично заключению по студенту (`buildStudentReport` в `admin.html`).
3. **Отчётность по всем студентам колледжа** — общий свод по всему колледжу.
4. **Фильтрация результатов** — на странице «Результаты» уже есть фильтры (группа/тест/даты);
   расширить (по уровню/риску, поиск по студенту).

**Отложено (по решению владельца):** тарифы/подписка; лендинг + демо-данные + триал; модуль согласий ПДн.

---

## 11. Что уже сделано (контекст)

Импорт/экспорт Excel, двуязычие RU/KZ, инфографика результатов (data-driven), движок методик
(подшкалы/обратные/достоверность), редактор своих методик (БД), печатные заключения, группа риска +
динамика, мультиарендность (БД на колледж), роли (супер-админ/админ/куратор/студент), управление
паролями, включение/отключение колледжей. Подробности — в `git log`.
