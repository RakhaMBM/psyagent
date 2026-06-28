let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user'));
const esc = window.escapeHtml;
let currentResultId = null;
let currentQuestionnaireId = null;
let myTestsCache = [];

if (!token || currentUser?.role !== 'student') {
    window.location.href = '/';
}

window.onLangChange = function () {
    loadUserInfo();
};

async function loadUserInfo() {
    try {
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) {
            throw new Error('Ошибка загрузки');
        }

        const user = await res.json();

        document.getElementById('studentInfo').textContent = user.full_name;
        document.getElementById('profileName').textContent = user.full_name;
        document.getElementById('profileGroup').textContent = user.group_name || '';
        document.getElementById('profileAge').textContent = user.age ? `${user.age} ${t('unit.years')}` : '';
        document.getElementById('profileEmail').textContent = user.email || '-';
        document.getElementById('profilePhone').textContent = user.phone || '-';
        document.getElementById('profileSchool').textContent = user.school || '-';
        document.getElementById('profileAddress').textContent = user.home_address || '-';

        loadProfile();
        loadMyTests();

    } catch (e) {
        console.error(e);
    }
}

async function loadProfile() {
    try {
        const res = await fetch('/api/profile', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const profile = await res.json();

        const info = document.getElementById('profileInfo');
        if (profile) {
            const familyKeys = { full: 'family.full', single_parent: 'family.single_parent', guardian: 'family.guardian', other: 'family.other' };
            const familyLabel = familyKeys[profile.family_type] ? t(familyKeys[profile.family_type]) : '-';
            info.innerHTML = `
                <div class="row">
                    <div class="col-6"><strong>${t('profile.family_type')}:</strong> ${familyLabel}</div>
                    <div class="col-6"><strong>${t('profile.lives_with')}:</strong> ${esc(profile.lives_with || '-')}</div>
                    <div class="col-6"><strong>${t('profile.school')}:</strong> ${esc(profile.school || '-')}</div>
                    <div class="col-6"><strong>${t('profile.address')}:</strong> ${esc(profile.home_address || '-')}</div>
                </div>
            `;
        } else {
            info.innerHTML = `<p class="text-muted text-center">${t('student.form_empty')}</p>`;
        }
    } catch (e) {}
}

function openProfileModal() {
    new bootstrap.Modal(document.getElementById('profileModal')).show();
}

document.getElementById('profileForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(this).entries());

    try {
        const res = await fetch('/api/profile', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('profileModal')).hide();
            loadProfile();
            alert(t('msg.form_saved'));
        }
    } catch (e) {
        alert(t('msg.save_error'));
    }
});

async function loadMyTests() {
    try {
        const res = await fetch('/api/my-tests', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error);
        }

        const testsRaw = await res.json();
        const tests = Array.isArray(testsRaw) ? testsRaw : (testsRaw?.data || []);
        myTestsCache = tests;

        const container = document.getElementById('testsContainer');

        if (tests.length === 0) {
            container.innerHTML = `
                <div class="text-center text-muted py-4">
                    <i class="bi bi-inbox display-4 d-block mb-2"></i>
                    <p>${t('student.no_tests')}</p>
                    <small class="text-muted">${t('student.no_tests_hint')}</small>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="list-group">
                ${tests.map(item => `
                    <div class="list-group-item d-flex justify-content-between align-items-center">
                        <div>
                            <h6 class="mb-1">${esc(item.title)}</h6>
                            <small class="text-muted">
                                ${item.questions_count || '?'} ${t('tests.q_count')}
                                ${item.due_date ? `| ${t('msg.due')}: ${formatDate(item.due_date)}` : ''}
                            </small>
                        </div>
                        <div>
                            ${getStatusBadge(item.assignment_status, item.result_status)}
                            ${item.result_status !== 'completed' && !['completed', 'expired'].includes(item.assignment_status) ? `
                                <button class="btn btn-sm btn-primary ms-2" data-action="startTest" data-action-args='[${item.assignment_id},${item.id}]'>
                                    ${item.result_status === 'in_progress' ? t('test.continue') : t('test.start')}
                                </button>
                            ` : `
                                <span class="badge bg-success ms-2">${t('test.passed')}</span>
                            `}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (e) {
        document.getElementById('testsContainer').innerHTML = `
            <div class="alert alert-danger">${t('msg.tests_load_error')}: ${esc(e.message)}</div>
        `;
    }
}

function getStatusBadge(assignStatus, resultStatus) {
    if (resultStatus === 'completed' || assignStatus === 'completed') return `<span class="badge bg-success">${t('st.completed')}</span>`;
    if (assignStatus === 'expired') return `<span class="badge bg-danger">${t('st.expired')}</span>`;
    if (assignStatus === 'started' || resultStatus === 'in_progress') return `<span class="badge bg-warning text-dark">${t('st.in_progress')}</span>`;
    return `<span class="badge bg-secondary">${t('st.assigned')}</span>`;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU');
}

async function startTest(assignmentId, questionnaireId) {
    const assignedTest = myTestsCache.find(item => item.assignment_id === assignmentId);
    const title = assignedTest ? assignedTest.title : '';
    currentQuestionnaireId = questionnaireId;
    document.getElementById('testTitle').textContent = title;

    try {
        const startRes = await fetch('/api/results/start', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ assignmentId })
        });

        const startData = await startRes.json();
        if (!startRes.ok) throw new Error(startData.error || t('msg.error'));
        currentResultId = startData.resultId;

        const qRes = await fetch(`/api/questionnaires/${questionnaireId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const questionnaire = await qRes.json();
        if (!qRes.ok) throw new Error(questionnaire.error || t('msg.test_load_error'));

        renderQuestions(questionnaire.questions, questionnaire.instruction);
        applyAnswers(startData.answers || {});
        new bootstrap.Modal(document.getElementById('testModal')).show();

    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

function renderQuestions(questions, instruction = '') {
    const questionsArray = Array.isArray(questions) ? questions : [];

    const container = document.getElementById('testQuestions');

    const optLabel = (opt) => (opt && typeof opt === 'object') ? opt.text : opt;

    const instructionHtml = instruction
        ? `<div class="alert alert-info"><i class="bi bi-info-circle me-2"></i>${esc(instruction)}</div>`
        : '';

    container.innerHTML = instructionHtml + questionsArray.map((q, idx) => {
        let inputHtml = '';
        const scaleMin = Number.isFinite(Number(q.scale_min)) ? Number(q.scale_min) : 1;
        const scaleMax = Number.isFinite(Number(q.scale_max)) ? Number(q.scale_max) : 5;
        const scaleDefault = Math.round((scaleMin + scaleMax) / 2);

        switch (q.question_type) {
            case 'single':
                inputHtml = `
                    <div class="mt-2">
                        ${(q.options || []).map((opt, i) => `
                            <div class="form-check">
                                <input class="form-check-input" type="radio"
                                       name="q_${idx}" id="q${idx}_opt${i}" value="${esc(optLabel(opt))}">
                                <label class="form-check-label" for="q${idx}_opt${i}">${esc(optLabel(opt))}</label>
                            </div>
                        `).join('')}
                    </div>
                `;
                break;

            case 'multiple':
                inputHtml = `
                    <div class="mt-2">
                        ${(q.options || []).map((opt, i) => `
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox"
                                       name="q_${idx}[]" id="q${idx}_opt${i}" value="${esc(optLabel(opt))}">
                                <label class="form-check-label" for="q${idx}_opt${i}">${esc(optLabel(opt))}</label>
                            </div>
                        `).join('')}
                    </div>
                `;
                break;

            case 'scale':
                inputHtml = `
                    <div class="mt-3">
                        <div class="d-flex justify-content-between small text-muted mb-1">
                            <span>${esc((q.scaleLabels?.min || q.scale_min) || 1)}</span>
                            <span>${esc((q.scaleLabels?.max || q.scale_max) || 5)}</span>
                        </div>
                         <input type="range" class="form-range" name="q_${idx}"
                                min="${scaleMin}" max="${scaleMax}" value="${scaleDefault}">
                         <div class="text-center"><strong id="scaleVal_${idx}">${scaleDefault}</strong></div>
                    </div>
                `;
                break;

            case 'text':
                inputHtml = `
                    <div class="mt-2">
                        <textarea class="form-control" name="q_${idx}" rows="3"
                                  placeholder="${t('test.answer_ph')}"></textarea>
                    </div>
                `;
                break;
        }

        return `
            <div class="card mb-3">
                <div class="card-body">
                    <h6 class="card-title">
                        <span class="badge bg-primary me-2">${idx + 1}</span>
                         ${esc(q.question_text)}
                        ${q.is_required ? '<span class="text-danger">*</span>' : ''}
                    </h6>
                    ${inputHtml}
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('input[type="range"]').forEach(range => {
        range.addEventListener('input', function () {
            const idx = this.name.split('_')[1];
            document.getElementById(`scaleVal_${idx}`).textContent = this.value;
        });
    });
}

function applyAnswers(answers) {
    const form = document.getElementById('testQuestions');
    Object.entries(answers || {}).forEach(([idx, value]) => {
        const controls = form.querySelectorAll(`[name="q_${idx}"], [name="q_${idx}[]"]`);
        controls.forEach(control => {
            if (control.type === 'radio') control.checked = control.value === value;
            else if (control.type === 'checkbox') control.checked = Array.isArray(value) && value.includes(control.value);
            else if (control.type === 'range') {
                control.value = value;
                const label = document.getElementById(`scaleVal_${idx}`);
                if (label) label.textContent = control.value;
            } else {
                control.value = value == null ? '' : value;
            }
        });
    });
}

function collectAnswers() {
    const answers = {};
    const form = document.getElementById('testQuestions');

    form.querySelectorAll('input[type="radio"]:checked').forEach(radio => {
        const idx = radio.name.split('_')[1];
        answers[idx] = radio.value;
    });

    form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        const idx = cb.name.split('_')[1].replace('[]', '');
        if (!answers[idx]) answers[idx] = [];
        if (cb.checked) answers[idx].push(cb.value);
    });

    form.querySelectorAll('input[type="range"]').forEach(range => {
        const idx = range.name.split('_')[1];
        answers[idx] = parseInt(range.value);
    });

    form.querySelectorAll('textarea').forEach(ta => {
        const idx = ta.name.split('_')[1];
        answers[idx] = ta.value;
    });

    return answers;
}

async function saveAndClose() {
    if (!currentResultId) return;

    const answers = collectAnswers();

    try {
        const res = await fetch('/api/results/save', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ resultId: currentResultId, answers })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('msg.save_error'));

        bootstrap.Modal.getInstance(document.getElementById('testModal')).hide();
        loadMyTests();
        alert(t('msg.draft_saved'));
    } catch (e) {
        alert(t('msg.save_error'));
    }
}

async function completeTest() {
    if (!currentResultId) return;

    if (!confirm(t('msg.confirm_finish'))) {
        return;
    }

    const answers = collectAnswers();

    try {
        const res = await fetch('/api/results/complete', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ resultId: currentResultId, answers })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('msg.error'));

        bootstrap.Modal.getInstance(document.getElementById('testModal')).hide();
        loadMyTests();
        alert('✅ ' + t('msg.test_finished') + '\n\n' + t('msg.results_hidden') + '\n\n' + t('msg.thanks'));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}

loadUserInfo();
