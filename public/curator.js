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
            <td>
                <button class="btn btn-sm btn-outline-primary d-none" data-ai-only data-action="openStudentAiAnalysis" data-action-args='[${s.id}]' title="${t('ai.title')}"><i class="bi bi-stars"></i></button>
                <button class="btn btn-sm btn-outline-secondary" data-action="downloadStudentReport" data-action-args='[${s.id}]'><i class="bi bi-file-earmark-pdf me-1"></i>${t('report.download')}</button>
            </td>
        </tr>`).join('');
    window.PsyAi?.reveal();
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

// ИИ-анализ: имя студента показывается только в заголовке модалки, на сервер не уходит.
function openStudentAiAnalysis(studentId) {
    const student = studentsCache.find(s => s.id === studentId);
    window.PsyAi?.openModal('student', studentId, student ? student.full_name : '');
}

function openGroupAiAnalysis() {
    if (!user.groupName) return;
    window.PsyAi?.openModal('group', user.groupName, user.groupName);
}

// Скачивание PDF-заключения по студенту (read-only, по данным группы).
async function downloadStudentReport(studentId) {
    const student = studentsCache.find(s => s.id === studentId);
    if (!student) return;
    const results = resultsCache.filter(r => r.user_id === studentId);
    let aiAnalysis = '';
    try {
        if (window.PsyAi?.enabled) {
            const params = new URLSearchParams({ scope: 'student', targetId: String(studentId) });
            const res = await fetch(`/api/ai/analysis?${params}`, { headers: authHeaders });
            if (res.ok) aiAnalysis = (await res.json())?.analysis?.content || '';
        }
    } catch (e) {}
    try {
        window.PsyPdf.download(
            window.PsyPdf.buildStudentReport(student, results, { aiAnalysis }),
            `${t('report.title')}-${student.full_name}-${new Date().toISOString().slice(0, 10)}`
        );
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

init();
