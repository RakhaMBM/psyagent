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
            <td><button class="btn btn-sm btn-outline-secondary" data-action="printStudentReport" data-action-args='[${s.id}]'><i class="bi bi-printer me-1"></i>${t('report.print')}</button></td>
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

// Печать заключения по студенту (read-only, по данным группы)
function printStudentReport(studentId) {
    const student = studentsCache.find(s => s.id === studentId);
    if (!student) return;
    const results = resultsCache.filter(r => r.user_id === studentId)
        .sort((a, b) => new Date(a.completed_at || 0) - new Date(b.completed_at || 0));

    const resultBody = (r) => {
        const m = methodologyForResult(r);
        if (m && window.scoreMethodology && r.answers) {
            const sc = window.scoreMethodology(m, r.answers);
            const warns = sc.validity.filter(v => v.failed).map(v => `<p class="warn">⚠ ${esc(v.warning || v.name)} (${v.value})</p>`).join('');
            const rows = sc.scales.filter(s => s.display !== false).map(s => `<tr><td>${esc(s.name)}</td><td>${s.raw}${s.maxScore != null ? ' / ' + s.maxScore : ''}</td><td>${s.interp ? esc(s.interp.label) : '—'}</td></tr>`).join('');
            return `${warns}<table class="scales"><thead><tr><th>${t('rmodal.scale')}</th><th>${t('table.score')}</th><th>${t('rmodal.interpretation')}</th></tr></thead><tbody>${rows}</tbody></table>`;
        }
        return `<p>${t('table.score')}: <strong>${r.score}</strong></p>`;
    };

    const inner = `
        <h1>${t('report.title')}</h1>
        <p class="date">${new Date().toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU')}</p>
        <table class="info">
            <tr><td>${t('table.fio')}</td><td>${esc(student.full_name)}</td></tr>
            <tr><td>${t('table.group')}</td><td>${esc(student.group_name || '—')}</td></tr>
            <tr><td>${t('table.birth_date')}</td><td>${fmtDate(student.birth_date)}</td></tr>
            <tr><td>${t('field.school')}</td><td>${esc(student.school || '—')}</td></tr>
        </table>
        <h2>${t('report.results')}</h2>
        ${results.length ? results.map(r => `<div class="result"><h3>${esc(r.questionnaire_title)}</h3><p class="meta">${t('table.date')}: ${fmtDateTime(r.completed_at)}</p>${resultBody(r)}</div>`).join('') : `<p class="muted">${t('report.no_results')}</p>`}
        <div class="sign">${t('report.psychologist')}: ____________________</div>`;

    const w = window.open('', '_blank');
    if (!w) { alert(t('report.popup_blocked')); return; }
    w.document.write(`<!DOCTYPE html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${t('report.title')}</title>
        <style>
            @page { margin: 18mm; }
            body { font-family: 'Times New Roman', Georgia, serif; color:#000; font-size:13px; line-height:1.5; }
            h1 { font-size:18px; text-align:center; margin:0 0 4px; }
            h2 { font-size:15px; border-bottom:1px solid #000; padding-bottom:2px; margin-top:18px; }
            h3 { font-size:14px; margin:10px 0 4px; }
            .date { text-align:center; color:#555; margin:0 0 16px; }
            .meta { color:#555; margin:0 0 4px; font-size:12px; }
            table { width:100%; border-collapse:collapse; margin:6px 0; }
            table.info td { padding:3px 6px; border:1px solid #999; }
            table.info td:first-child { width:35%; font-weight:bold; background:#f3f3f3; }
            table.scales th, table.scales td { border:1px solid #999; padding:4px 6px; text-align:left; }
            table.scales th { background:#f3f3f3; }
            .result { page-break-inside: avoid; margin-bottom:10px; }
            .warn { color:#b00; font-weight:bold; margin:4px 0; }
            .muted { color:#777; } .sign { margin-top:28px; }
        </style></head><body>${inner}</body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
}

init();
