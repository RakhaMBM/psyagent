const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'curator') window.location.href = '/';

const authHeaders = { 'Authorization': 'Bearer ' + token };
let studentsCache = [];
let resultsCache = [];

window.onLangChange = function () { renderStudents(); renderResults(); };

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}
function fmtDate(d) { return d ? new Date(d).toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU') : '-'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU') : '-'; }
function methodologyForResult(result) {
    if (result && result.methodology_data) {
        try {
            return typeof result.methodology_data === 'string'
                ? JSON.parse(result.methodology_data)
                : result.methodology_data;
        } catch (_) {}
    }
    return window.findMethodologyByTitle
        ? window.findMethodologyByTitle(result && result.questionnaire_title)
        : null;
}

async function loadCustomMethodologies() {
    try {
        const res = await fetch('/api/methodologies', { headers: authHeaders });
        const raw = await res.json();
        if (window.registerMethodologies) window.registerMethodologies(Array.isArray(raw) ? raw : []);
    } catch (e) {}
}

async function init() {
    await loadCustomMethodologies();
    try {
        const me = await (await fetch('/api/auth/me', { headers: authHeaders })).json();
        document.getElementById('whoami').textContent = me.full_name || user.fullName || '';
    } catch (e) {}
    document.getElementById('groupName').textContent = user.groupName || '—';
    if (!user.groupName) document.getElementById('noGroup').classList.remove('d-none');

    const [sRaw, rRaw] = await Promise.all([
        fetch('/api/students', { headers: authHeaders }).then(r => r.json()).catch(() => []),
        fetch('/api/results', { headers: authHeaders }).then(r => r.json()).catch(() => [])
    ]);
    studentsCache = Array.isArray(sRaw) ? sRaw : [];
    resultsCache = Array.isArray(rRaw) ? rRaw : [];
    renderStudents();
    renderResults();
}

function renderStudents() {
    const tb = document.getElementById('studentsBody');
    if (studentsCache.length === 0) {
        tb.innerHTML = `<tr><td colspan="5" class="text-center py-3 text-muted">${t('students.not_found')}</td></tr>`;
        return;
    }
    tb.innerHTML = studentsCache.map(s => `
        <tr>
            <td class="fw-semibold">${esc(s.full_name)}</td>
            <td>${fmtDate(s.birth_date)}</td>
            <td>${s.age != null ? s.age + ' ' + t('unit.years') : '-'}</td>
            <td>${esc(s.school || '-')}</td>
            <td><button class="btn btn-sm btn-outline-secondary" data-action="downloadStudentReport" data-action-args='[${s.id}]'><i class="bi bi-file-earmark-pdf me-1"></i>${t('report.download')}</button></td>
        </tr>`).join('');
}

function resultInterp(r) {
    const m = methodologyForResult(r);
    if (m && window.scoreMethodology && r.answers) {
        const sc = window.scoreMethodology(m, r.answers);
        return sc.primary && sc.primary.interp ? sc.primary.interp.label : '';
    }
    return '';
}

function renderResults() {
    const tb = document.getElementById('resultsBody');
    if (resultsCache.length === 0) {
        tb.innerHTML = `<tr><td colspan="4" class="text-center py-3 text-muted">${t('results.not_found')}</td></tr>`;
        return;
    }
    tb.innerHTML = resultsCache.map(r => {
        const interp = resultInterp(r);
        return `<tr>
            <td class="fw-semibold">${esc(r.full_name)}</td>
            <td>${esc(r.questionnaire_title)}</td>
            <td><span class="badge bg-secondary">${r.score}</span>${interp ? ` <small class="text-muted">${esc(interp)}</small>` : ''}</td>
            <td>${fmtDateTime(r.completed_at)}</td>
        </tr>`;
    }).join('');
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Скачивание PDF-заключения по студенту (read-only, по данным группы).
function downloadStudentReport(studentId) {
    const student = studentsCache.find(s => s.id === studentId);
    if (!student) return;
    const results = resultsCache.filter(r => r.user_id === studentId)
        .sort((a, b) => new Date(a.completed_at || 0) - new Date(b.completed_at || 0));

    const content = [
        { text: t('report.title'), style: 'title' },
        {
            text: new Date().toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU'),
            style: 'date'
        },
        window.PsyPdf.keyValueTable([
            [t('table.fio'), student.full_name],
            [t('table.group'), student.group_name || '—'],
            [t('table.birth_date'), fmtDate(student.birth_date)],
            [t('field.school'), student.school || '—']
        ]),
        { text: t('report.results'), style: 'section' }
    ];

    if (!results.length) content.push({ text: t('report.no_results'), color: '#667085' });
    results.forEach(result => {
        content.push(
            { text: result.questionnaire_title, style: 'subsection' },
            { text: `${t('table.date')}: ${fmtDateTime(result.completed_at)}`, style: 'meta' }
        );
        const methodology = methodologyForResult(result);
        if (methodology && window.scoreMethodology && result.answers) {
            const scored = window.scoreMethodology(methodology, result.answers);
            scored.validity.filter(item => item.failed).forEach(item => {
                content.push({
                    text: `⚠ ${item.warning || item.name} (${item.value})`,
                    style: 'warning'
                });
            });
            content.push(window.PsyPdf.table(
                [t('rmodal.scale'), t('table.score'), t('rmodal.interpretation')],
                scored.scales.filter(scale => scale.display !== false).map(scale => [
                    scale.name,
                    `${scale.raw}${scale.maxScore != null ? ` / ${scale.maxScore}` : ''}`,
                    scale.interp ? scale.interp.label : '—'
                ]),
                ['42%', '18%', '40%']
            ));
        } else {
            content.push({ text: `${t('table.score')}: ${result.score}`, margin: [0, 0, 0, 5] });
        }
    });
    content.push({ text: `${t('report.psychologist')}: ____________________`, style: 'signature' });

    try {
        window.PsyPdf.download(
            window.PsyPdf.baseDefinition(content, { title: t('report.title') }),
            `${t('report.title')}-${student.full_name}-${new Date().toISOString().slice(0, 10)}`
        );
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

init();
