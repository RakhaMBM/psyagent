let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user'));
const esc = window.escapeHtml;
let adminStudentsCache = [];
let adminCuratorsCache = [];
let adminTestsCache = [];
const selectedAdminUsers = {
    student: new Set(),
    curator: new Set()
};

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

if (!token || currentUser?.role !== 'admin') {
    window.location.href = '/';
}

document.getElementById('adminName').textContent = currentUser.fullName;

let groupsChart = null;

loadDashboardStats();
loadGroupsForFilters();
loadStudents();
loadTests();
loadTestsForFilter();
loadCustomMethodologies();
loadAnonymousTemplates();

// Перерисовка динамических частей при смене языка
window.onLangChange = function () {
    loadDashboardStats();
    loadStudents();
    loadTests();
    loadResults();
    loadMethodologiesList();
    loadAnonymousCampaigns();
};

function showSection(sectionName, trigger) {
    document.querySelectorAll('main > section').forEach(s => s.classList.add('d-none'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    document.getElementById(`section-${sectionName}`).classList.remove('d-none');
    trigger?.closest('.nav-link')?.classList.add('active');

    if (sectionName === 'dashboard') loadDashboardStats();
    if (sectionName === 'results') loadResults();
    if (sectionName === 'methodologies') loadMethodologiesList();
    if (sectionName === 'curators') loadCurators();
    if (sectionName === 'anonymous') loadAnonymousCampaigns();
}

function adminUserSelectionConfig(role) {
    return role === 'curator'
        ? {
            cache: adminCuratorsCache,
            selected: selectedAdminUsers.curator,
            countId: 'selectedCuratorsCount',
            selectAllId: 'selectAllCurators',
            resetButtonId: 'bulkResetCuratorsBtn',
            deactivateButtonId: 'bulkDeactivateCuratorsBtn'
        }
        : {
            cache: adminStudentsCache,
            selected: selectedAdminUsers.student,
            countId: 'selectedStudentsCount',
            selectAllId: 'selectAllStudents',
            resetButtonId: 'bulkResetStudentsBtn',
            deactivateButtonId: 'bulkDeactivateStudentsBtn'
        };
}

function updateAdminUserSelection(role) {
    const config = adminUserSelectionConfig(role);
    const selectedCount = config.selected.size;
    const count = document.getElementById(config.countId);
    if (count) count.textContent = selectedCount;
    [config.resetButtonId, config.deactivateButtonId].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = selectedCount === 0;
    });
    const selectAll = document.getElementById(config.selectAllId);
    if (selectAll) {
        selectAll.checked = config.cache.length > 0 && selectedCount === config.cache.length;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < config.cache.length;
    }
}

function resetAdminUserSelection(role) {
    adminUserSelectionConfig(role).selected.clear();
    updateAdminUserSelection(role);
}

function toggleUserSelection(role, userId, element) {
    const config = adminUserSelectionConfig(role);
    if (element.checked) config.selected.add(Number(userId));
    else config.selected.delete(Number(userId));
    updateAdminUserSelection(role);
}

function toggleAllUsers(role, element) {
    const config = adminUserSelectionConfig(role);
    config.selected.clear();
    if (element.checked) {
        config.cache.forEach(item => config.selected.add(Number(item.id)));
    }
    document.querySelectorAll(`[data-user-select="${role}"]`).forEach(checkbox => {
        checkbox.checked = element.checked;
    });
    updateAdminUserSelection(role);
}

// ===== Анонимные опросы =====
let anonymousCampaignsCache = [];

async function loadAnonymousTemplates() {
    const select = document.getElementById('anonymousTemplate');
    if (!select) return;
    try {
        const response = await fetch('/api/anonymous-campaigns/templates', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const templates = await response.json();
        if (!response.ok) throw new Error(templates.error || t('msg.error'));
        const previous = select.value;
        select.innerHTML = `<option value="">${t('anonymous.choose_template')}</option>` +
            templates.map(template =>
                `<option value="${esc(template.id)}">${esc(template.title)} · ${template.questionsCount} ${t('tests.q_count')}</option>`
            ).join('');
        select.value = previous;
    } catch (error) {
        select.innerHTML = `<option value="">${t('anonymous.load_error')}</option>`;
    }
}

async function loadAnonymousCampaigns() {
    const body = document.getElementById('anonymousCampaignsBody');
    if (!body) return;
    try {
        const response = await fetch('/api/anonymous-campaigns', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const campaigns = await response.json();
        if (!response.ok) throw new Error(campaigns.error || t('msg.error'));
        anonymousCampaignsCache = Array.isArray(campaigns) ? campaigns : [];
        if (!anonymousCampaignsCache.length) {
            body.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">${t('anonymous.empty')}</td></tr>`;
            return;
        }
        body.innerHTML = anonymousCampaignsCache.map(campaign => {
            const closedByDate = campaign.closes_at && new Date(campaign.closes_at) < new Date();
            const active = Boolean(campaign.is_active) && !closedByDate;
            return `
                <tr>
                    <td>
                        <div class="fw-semibold">${esc(campaign.title)}</div>
                        <small class="text-muted">${formatDateTime(campaign.created_at)}</small>
                    </td>
                    <td>${esc(campaign.target_group || '—')}</td>
                    <td><span class="badge bg-primary">${Number(campaign.response_count) || 0}</span></td>
                    <td>${active
                        ? `<span class="badge bg-success">${t('anonymous.active')}</span>`
                        : `<span class="badge bg-secondary">${t('anonymous.closed')}</span>`}</td>
                    <td>
                        <div class="btn-group btn-group-sm">
                            <button class="btn btn-outline-primary" data-action="copyAnonymousLink" data-action-args='[${campaign.id}]' title="${t('anonymous.copy_link')}">
                                <i class="bi bi-copy"></i>
                            </button>
                            <button class="btn btn-outline-info" data-action="viewAnonymousReport" data-action-args='[${campaign.id}]' title="${t('anonymous.view_report')}">
                                <i class="bi bi-bar-chart"></i>
                            </button>
                            <button class="btn btn-outline-secondary" data-action="toggleAnonymousCampaign" data-action-args='[${campaign.id},${active ? 'false' : 'true'}]' title="${active ? t('anonymous.close') : t('anonymous.reopen')}">
                                <i class="bi ${active ? 'bi-stop-circle' : 'bi-play-circle'}"></i>
                            </button>
                            <button class="btn btn-outline-danger" data-action="deleteAnonymousCampaign" data-action-args='[${campaign.id}]' title="${t('common.delete')}">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join('');
    } catch (error) {
        body.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-danger">${esc(error.message)}</td></tr>`;
    }
}

document.getElementById('anonymousCampaignForm')?.addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = document.getElementById('anonymousCreateButton');
    button.disabled = true;
    try {
        const response = await fetch('/api/anonymous-campaigns', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                surveyKey: document.getElementById('anonymousTemplate').value,
                targetGroup: document.getElementById('anonymousTargetGroup').value.trim(),
                closesAt: document.getElementById('anonymousClosesAt').value || null
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('msg.error'));
        this.reset();
        await loadAnonymousCampaigns();
        const url = new URL(data.public_path, window.location.origin).href;
        try {
            await navigator.clipboard.writeText(url);
            alert(t('anonymous.created_copied'));
        } catch (_) {
            prompt(t('anonymous.copy_prompt'), url);
        }
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    } finally {
        button.disabled = false;
    }
});

async function copyAnonymousLink(id) {
    const campaign = anonymousCampaignsCache.find(item => item.id === id);
    if (!campaign) return;
    const url = new URL(campaign.public_path, window.location.origin).href;
    try {
        await navigator.clipboard.writeText(url);
        alert(t('anonymous.link_copied'));
    } catch (_) {
        prompt(t('anonymous.copy_prompt'), url);
    }
}

async function toggleAnonymousCampaign(id, isActive) {
    if (!confirm(isActive ? t('anonymous.confirm_reopen') : t('anonymous.confirm_close'))) return;
    try {
        const response = await fetch(`/api/anonymous-campaigns/${id}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ is_active: isActive })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('msg.error'));
        loadAnonymousCampaigns();
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

async function deleteAnonymousCampaign(id) {
    if (!confirm(t('anonymous.confirm_delete'))) return;
    try {
        const response = await fetch(`/api/anonymous-campaigns/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('msg.error'));
        loadAnonymousCampaigns();
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

async function viewAnonymousReport(id) {
    try {
        const response = await fetch(`/api/anonymous-campaigns/${id}/report`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const report = await response.json();
        if (!response.ok) throw new Error(report.error || t('msg.error'));
        document.getElementById('anonymousReportTitle').textContent = report.campaign.title;
        document.getElementById('anonymousReportBody').innerHTML = `
            <div class="row g-3 mb-4">
                <div class="col-md-4"><div class="stat-card stat-card-primary"><div class="stat-icon"><i class="bi bi-chat-square-check"></i></div><div class="stat-info"><h3>${report.response_count}</h3><p>${t('anonymous.responses')}</p></div></div></div>
                <div class="col-md-8"><div class="alert alert-success mb-0"><i class="bi bi-incognito me-2"></i>${t('anonymous.aggregate_only')}</div></div>
            </div>
            ${report.questions.map((question, index) => `
                <div class="card mb-3">
                    <div class="card-body">
                        <h6>${index + 1}. ${esc(question.text)}</h6>
                        <div class="table-responsive">
                            <table class="table table-sm mb-0">
                                <tbody>${question.options.map(option => `
                                    <tr>
                                        <td>${esc(option.text)}</td>
                                        <td class="text-end text-nowrap">${option.count} (${option.percent}%)</td>
                                    </tr>`).join('')}
                                    ${question.skipped ? `<tr class="text-muted"><td>${t('anonymous.skipped')}</td><td class="text-end">${question.skipped}</td></tr>` : ''}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>`).join('')}
        `;
        new bootstrap.Modal(document.getElementById('anonymousReportModal')).show();
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

// ===== Кураторы =====
async function loadCurators() {
    // Подсказка групп для формы
    try {
        const groups = await (await fetch('/api/groups', { headers: { 'Authorization': `Bearer ${token}` } })).json();
        const dl = document.getElementById('curatorGroups');
        if (dl && Array.isArray(groups)) dl.innerHTML = groups.map(g => `<option value="${esc(g.group_name)}">`).join('');
    } catch (e) {}

    const tbody = document.getElementById('curatorsBody');
    try {
        const res = await fetch('/api/curators', { headers: { 'Authorization': `Bearer ${token}` } });
        const raw = await res.json();
        const list = Array.isArray(raw) ? raw : [];
        adminCuratorsCache = list;
        resetAdminUserSelection('curator');
        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">${t('curators.empty')}</td></tr>`;
            return;
        }
        tbody.innerHTML = list.map(c => `
            <tr>
                <td class="selection-column">
                    <input class="form-check-input" type="checkbox" data-user-select="curator"
                           data-action="toggleUserSelection" data-action-args='["curator",${c.id}]'
                           data-action-event="change" data-action-pass="element"
                           aria-label="${t('users.selected')}: ${esc(c.full_name)}">
                </td>
                <td class="fw-semibold">${esc(c.full_name)}</td>
                <td><code>${esc(c.username)}</code></td>
                <td>${esc(c.group_name || '-')}</td>
                <td>
                    <button class="btn btn-sm btn-outline-danger" data-action="deleteCurator" data-action-args='[${c.id}]' title="${t('common.delete')}"><i class="bi bi-trash"></i></button>
                </td>
            </tr>`).join('');
    } catch (e) {
        adminCuratorsCache = [];
        resetAdminUserSelection('curator');
        tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-danger">${t('msg.error')}</td></tr>`;
    }
}

document.getElementById('curatorForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(this).entries());
    if ((data.password || '').length < 8) { alert(t('pw.min')); return; }
    try {
        const res = await fetch('/api/curators', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || t('msg.error'));
        this.reset();
        loadCurators();
        alert(t('curators.created'));
    } catch (err) {
        alert(t('msg.error') + ': ' + err.message);
    }
});

async function deleteCurator(id) {
    if (!confirm(t('curators.confirm_delete'))) return;
    try {
        const res = await fetch(`/api/curators/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error(await res.text());
        loadCurators();
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

// ============================================
// ПОЛЬЗОВАТЕЛЬСКИЕ МЕТОДИКИ (список + редактор)
// ============================================
let customMethodologies = [];

async function loadCustomMethodologies() {
    try {
        const res = await fetch('/api/methodologies', { headers: { 'Authorization': `Bearer ${token}` } });
        const raw = await res.json();
        customMethodologies = Array.isArray(raw) ? raw : [];
        if (window.registerMethodologies) window.registerMethodologies(customMethodologies);
    } catch (e) {
        customMethodologies = [];
    }
    loadMethodologiesList();
    populateMethodologySelect();
    loadDashboardStats(); // обновляем группу риска с учётом пользовательских методик
}

function loadMethodologiesList() {
    const container = document.getElementById('methodologiesList');
    if (!container) return;
    const builtin = window.PSY_METHODOLOGIES || [];
    const cards = [];

    builtin.forEach(m => {
        cards.push(`
            <div class="col-md-6 col-lg-4">
                <div class="card h-100">
                    <div class="card-body">
                        <span class="badge bg-secondary mb-2">${t('meth.builtin')}</span>
                        <h6 class="card-title">${esc(m.title)}</h6>
                        <p class="card-text text-muted small">${esc(m.description || '')}</p>
                        <small class="text-muted">${(m.questions || []).length} ${t('tests.q_count')}</small>
                    </div>
                </div>
            </div>`);
    });

    customMethodologies.forEach(m => {
        cards.push(`
            <div class="col-md-6 col-lg-4">
                <div class="card h-100 border-primary">
                    <div class="card-body">
                        <span class="badge bg-primary mb-2">${t('meth.custom')}</span>
                        <h6 class="card-title">${esc(m.title)}</h6>
                        <p class="card-text text-muted small">${esc(m.description || '')}</p>
                        <small class="text-muted">${(m.questions || []).length} ${t('tests.q_count')}</small>
                    </div>
                    <div class="card-footer bg-transparent border-top-0 d-flex gap-2">
                        <button class="btn btn-sm btn-outline-primary" data-action="openMethodologyEditor" data-action-args='[${m._dbId}]'>
                            <i class="bi bi-pencil me-1"></i>${t('common.edit')}
                        </button>
                        <button class="btn btn-sm btn-outline-danger" data-action="deleteMethodology" data-action-args='[${m._dbId}]'>
                            <i class="bi bi-trash me-1"></i>${t('common.delete')}
                        </button>
                    </div>
                </div>
            </div>`);
    });

    container.innerHTML = cards.join('') ||
        `<div class="col-12 text-muted">${t('meth.empty')}</div>`;
}

// ---------- Редактор методики: строки ----------
function meAddOption(text = '', score = '') {
    document.getElementById('meAnswerOptions').insertAdjacentHTML('beforeend', `
        <div class="row g-2 mb-2 me-option-row align-items-center">
            <div class="col"><input class="form-control form-control-sm me-opt-text" placeholder="${t('meth.opt_text')}" value="${esc(text)}"></div>
            <div class="col-auto" style="width:130px"><input type="number" class="form-control form-control-sm me-opt-score" placeholder="${t('meth.opt_score')}" value="${esc(score)}"></div>
            <div class="col-auto"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-closest=".me-option-row">×</button></div>
        </div>`);
}

function meAddScale(name = '', maxScore = '') {
    document.getElementById('meScales').insertAdjacentHTML('beforeend', `
        <div class="card mb-2 me-scale-card">
            <div class="card-body p-2">
                <div class="row g-2 mb-2 align-items-center">
                    <div class="col"><input class="form-control form-control-sm me-scale-name" placeholder="${t('meth.scale_name')}" data-action="meRefreshScaleSelects" data-action-event="input" value="${esc(name)}"></div>
                    <div class="col-auto" style="width:130px"><input type="number" class="form-control form-control-sm me-scale-max" placeholder="${t('meth.scale_max')}" value="${esc(maxScore)}"></div>
                    <div class="col-auto"><button type="button" class="btn btn-sm btn-outline-danger" data-action="meRemoveScale" data-action-pass="element">×</button></div>
                </div>
                <div class="ms-2">
                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <small class="text-muted">${t('meth.interp_ranges')}</small>
                        <button type="button" class="btn btn-sm btn-outline-secondary" data-action="meAddRange" data-action-pass="element"><i class="bi bi-plus"></i></button>
                    </div>
                    <div class="me-ranges"></div>
                </div>
            </div>
        </div>`);
    meRefreshScaleSelects();
}

function meRemoveScale(btn) {
    btn.closest('.me-scale-card').remove();
    meRefreshScaleSelects();
}

function meAddRange(btn, range = {}) {
    const levelOpts = ['', 'low', 'medium', 'high'].map(l =>
        `<option value="${l}" ${range.level === l ? 'selected' : ''}>${l ? t('level.' + l) : '—'}</option>`).join('');
    btn.closest('.me-scale-card').querySelector('.me-ranges').insertAdjacentHTML('beforeend', `
        <div class="row g-2 mb-1 me-range-row align-items-center">
            <div class="col-auto" style="width:90px"><input type="number" class="form-control form-control-sm me-range-min" placeholder="${t('meth.range_min')}" value="${esc(range.min != null ? range.min : '')}"></div>
            <div class="col-auto" style="width:90px"><input type="number" class="form-control form-control-sm me-range-max" placeholder="${t('meth.range_max')}" value="${esc(range.max != null ? range.max : '')}"></div>
            <div class="col"><input class="form-control form-control-sm me-range-label" placeholder="${t('meth.range_label')}" value="${esc(range.label || '')}"></div>
            <div class="col-auto"><select class="form-select form-select-sm me-range-level" style="width:auto">${levelOpts}</select></div>
            <div class="col-auto"><div class="form-check" title="${t('meth.range_attention_hint')}"><input class="form-check-input me-range-attention" type="checkbox" ${range.attention ? 'checked' : ''}><label class="form-check-label small text-danger">${t('meth.range_attention')}</label></div></div>
            <div class="col-auto"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-closest=".me-range-row">×</button></div>
        </div>`);
}

function meAddQuestion(text = '', scaleId = '', reverse = false) {
    const n = document.querySelectorAll('#meQuestions .me-question-row').length + 1;
    document.getElementById('meQuestions').insertAdjacentHTML('beforeend', `
        <div class="row g-2 mb-2 me-question-row align-items-center">
            <div class="col-auto pt-1 text-muted small me-qnum" style="width:28px">${n}</div>
            <div class="col"><input class="form-control form-control-sm me-q-text" placeholder="${t('meth.q_text')}" value="${esc(text)}"></div>
            <div class="col-auto"><select class="form-select form-select-sm me-scale-select me-q-scale" style="width:auto" data-selected="${esc(scaleId)}"></select></div>
            <div class="col-auto"><div class="form-check" title="${t('meth.q_reverse')}"><input class="form-check-input me-q-reverse" type="checkbox" ${reverse ? 'checked' : ''}><label class="form-check-label small">${t('meth.reverse_short')}</label></div></div>
            <div class="col-auto"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-closest=".me-question-row" data-action="meRenumberQuestions">×</button></div>
        </div>`);
    meRefreshScaleSelects();
}

function meRenumberQuestions() {
    document.querySelectorAll('#meQuestions .me-qnum').forEach((el, i) => el.textContent = i + 1);
}

function meAddValidity(name = '', threshold = '', warning = '') {
    document.getElementById('meValidity').insertAdjacentHTML('beforeend', `
        <div class="row g-2 mb-2 me-validity-row align-items-center">
            <div class="col"><input class="form-control form-control-sm me-v-name" placeholder="${t('meth.v_name')}" data-action="meRefreshScaleSelects" data-action-event="input" value="${esc(name)}"></div>
            <div class="col-auto" style="width:120px"><input type="number" class="form-control form-control-sm me-v-threshold" placeholder="${t('meth.v_threshold')}" value="${esc(threshold)}"></div>
            <div class="col"><input class="form-control form-control-sm me-v-warning" placeholder="${t('meth.v_warning')}" value="${esc(warning)}"></div>
            <div class="col-auto"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-closest=".me-validity-row" data-action="meRefreshScaleSelects">×</button></div>
        </div>`);
    meRefreshScaleSelects();
}

// Список доступных шкал (обычные s0..N + шкалы достоверности v0..N) для выпадающих списков вопросов
function meScaleOptions() {
    const opts = [];
    document.querySelectorAll('#meScales .me-scale-card').forEach((card, i) => {
        opts.push({ id: 's' + i, name: card.querySelector('.me-scale-name').value.trim() || (t('rmodal.scale') + ' ' + (i + 1)) });
    });
    document.querySelectorAll('#meValidity .me-validity-row').forEach((row, i) => {
        const nm = row.querySelector('.me-v-name').value.trim() || (t('meth.validity') + ' ' + (i + 1));
        opts.push({ id: 'v' + i, name: nm + ' · ' + t('meth.validity') });
    });
    return opts;
}

function meRefreshScaleSelects() {
    const opts = meScaleOptions();
    document.querySelectorAll('.me-scale-select').forEach(sel => {
        const cur = sel.value || sel.getAttribute('data-selected') || '';
        sel.innerHTML = opts.length
            ? opts.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')
            : '<option value="s0">—</option>';
        if (opts.some(o => o.id === cur)) sel.value = cur;
    });
}

function serializeMethodology() {
    const answerOptions = [...document.querySelectorAll('#meAnswerOptions .me-option-row')].map(r => ({
        text: r.querySelector('.me-opt-text').value.trim(),
        score: Number(r.querySelector('.me-opt-score').value)
    })).filter(o => o.text !== '' && isFinite(o.score));

    const scales = [...document.querySelectorAll('#meScales .me-scale-card')].map((card, i) => {
        const maxV = card.querySelector('.me-scale-max').value;
        const interpretation = [...card.querySelectorAll('.me-range-row')].map(rr => {
            const level = rr.querySelector('.me-range-level').value;
            const o = {
                min: Number(rr.querySelector('.me-range-min').value),
                max: Number(rr.querySelector('.me-range-max').value),
                label: rr.querySelector('.me-range-label').value.trim()
            };
            if (level) o.level = level;
            if (rr.querySelector('.me-range-attention').checked) o.attention = true;
            return o;
        }).filter(x => x.label !== '');
        const scale = { id: 's' + i, name: card.querySelector('.me-scale-name').value.trim() || (t('rmodal.scale') + ' ' + (i + 1)), interpretation };
        if (maxV !== '') scale.maxScore = Number(maxV);
        return scale;
    });

    const questions = [...document.querySelectorAll('#meQuestions .me-question-row')].map(r => {
        const q = { text: r.querySelector('.me-q-text').value.trim(), scale: r.querySelector('.me-q-scale').value || 's0' };
        if (r.querySelector('.me-q-reverse').checked) q.reverse = true;
        return q;
    }).filter(q => q.text !== '');

    const validity = [...document.querySelectorAll('#meValidity .me-validity-row')].map((r, i) => ({
        id: 'v' + i,
        name: r.querySelector('.me-v-name').value.trim(),
        scale: 'v' + i,
        threshold: Number(r.querySelector('.me-v-threshold').value),
        warning: r.querySelector('.me-v-warning').value.trim()
    })).filter(v => v.name !== '');

    const meth = {
        title: document.getElementById('meName').value.trim(),
        description: document.getElementById('meDescription').value.trim(),
        instruction: document.getElementById('meInstruction').value.trim(),
        answerOptions,
        scales,
        questions
    };
    if (validity.length) meth.validity = validity;
    return meth;
}

function loadMethodologyIntoEditor(m) {
    document.getElementById('meName').value = m.title || '';
    document.getElementById('meDescription').value = m.description || '';
    document.getElementById('meInstruction').value = m.instruction || '';
    (m.answerOptions || []).forEach(o => meAddOption(o.text, o.score));
    (m.validity || []).forEach(v => meAddValidity(v.name, v.threshold, v.warning));
    const scales = (m.scales && m.scales.length) ? m.scales : [{ name: m.title, maxScore: m.maxScore, interpretation: m.interpretation || [] }];
    scales.forEach(s => {
        meAddScale(s.name, s.maxScore != null ? s.maxScore : '');
        const card = document.querySelector('#meScales .me-scale-card:last-child');
        const anyBtn = card.querySelector('button');
        (s.interpretation || []).forEach(r => meAddRange(anyBtn, r));
    });
    meRefreshScaleSelects();
    (m.questions || []).forEach(q => {
        const text = (q && typeof q === 'object') ? q.text : q;
        const scale = (q && typeof q === 'object') ? (q.scale || 's0') : 's0';
        const reverse = (q && typeof q === 'object') ? !!q.reverse : false;
        meAddQuestion(text, scale, reverse);
    });
    meRefreshScaleSelects();
}

function openMethodologyEditor(dbId) {
    document.getElementById('meAnswerOptions').innerHTML = '';
    document.getElementById('meScales').innerHTML = '';
    document.getElementById('meQuestions').innerHTML = '';
    document.getElementById('meValidity').innerHTML = '';
    document.getElementById('meDbId').value = dbId || '';
    document.getElementById('meTitle').textContent = dbId ? t('meth.edit') : t('meth.create');

    if (dbId) {
        const m = customMethodologies.find(x => x._dbId === dbId);
        if (m) loadMethodologyIntoEditor(m);
    } else {
        meAddOption('', '');
        meAddOption('', '');
        meAddScale('', '');
        meAddRange(document.querySelector('#meScales .me-scale-card button'));
        meAddQuestion();
    }
    new bootstrap.Modal(document.getElementById('methodologyEditorModal')).show();
}

async function saveMethodology() {
    const meth = serializeMethodology();
    if (!meth.title || meth.questions.length === 0 || meth.answerOptions.length === 0) {
        alert(t('meth.need_fields'));
        return;
    }
    const dbId = document.getElementById('meDbId').value;
    try {
        const res = await fetch(dbId ? `/api/methodologies/${dbId}` : '/api/methodologies', {
            method: dbId ? 'PUT' : 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(meth)
        });
        if (!res.ok) throw new Error(await res.text());
        bootstrap.Modal.getInstance(document.getElementById('methodologyEditorModal')).hide();
        await loadCustomMethodologies();
        alert(t('meth.saved'));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

async function deleteMethodology(dbId) {
    if (!confirm(t('meth.confirm_delete'))) return;
    try {
        const res = await fetch(`/api/methodologies/${dbId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        await loadCustomMethodologies();
        alert(t('meth.deleted'));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

async function loadDashboardStats() {
    try {
        const [studentsRes, groupsRes, resultsRes] = await Promise.all([
            fetch('/api/students', { headers: { 'Authorization': `Bearer ${token}` }}),
            fetch('/api/statistics/groups', { headers: { 'Authorization': `Bearer ${token}` }}),
            fetch('/api/results', { headers: { 'Authorization': `Bearer ${token}` }})
        ]);

        const studentsRaw = await studentsRes.json();
        const groupsRaw = await groupsRes.json();
        const resultsRaw = await resultsRes.json();

        const students = Array.isArray(studentsRaw) ? studentsRaw : (studentsRaw?.data || []);
        const groups = Array.isArray(groupsRaw) ? groupsRaw : (groupsRaw?.data || []);
        const results = Array.isArray(resultsRaw) ? resultsRaw : (resultsRaw?.data || []);

        document.getElementById('totalStudents').textContent = students.length;

        let completed = 0;
        groups.forEach(g => { completed += parseInt(g.completed_tests) || 0; });
        document.getElementById('completedTests').textContent = completed;
        document.getElementById('pendingTests').textContent = Math.max(0, students.length - completed);

        renderRiskGroup(results);

        const tbody = document.getElementById('groupsTableBody');
        if (groups.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">${t('common.no_data')}</td></tr>`;
        } else {
            tbody.innerHTML = groups.map(g => `
                <tr>
                    <td>${esc(g.group_name || '-')}</td>
                    <td>${g.total_students}</td>
                    <td><span class="badge bg-success">${g.completed_tests || 0}</span></td>
                </tr>
            `).join('');
        }

        renderCharts(groups, students);
    } catch (e) { console.error(e); }
}

// Группа риска: результаты, попавшие в диапазон, отмеченный методикой как attention.
function renderRiskGroup(results) {
    const tbody = document.getElementById('riskTableBody');
    const countEl = document.getElementById('riskCount');
    if (!tbody) return;

    const atRisk = [];
    (results || []).forEach(r => {
        const m = methodologyForResult(r);
        if (!m || !window.resultAttention) return;
        const a = window.resultAttention(m, r.answers || {});
        if (a.atRisk) atRisk.push({ r, reasons: a.reasons });
    });
    atRisk.sort((x, y) => new Date(y.r.completed_at || 0) - new Date(x.r.completed_at || 0));

    if (countEl) countEl.textContent = atRisk.length;
    if (atRisk.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">${t('risk.empty')}</td></tr>`;
        return;
    }
    tbody.innerHTML = atRisk.map(({ r, reasons }) => `
        <tr>
            <td class="fw-semibold">${esc(r.full_name)}</td>
            <td>${esc(r.group_name || '-')}</td>
            <td>${esc(r.questionnaire_title)}</td>
            <td><span class="badge bg-danger">${esc(reasons.map(x => x.label).join('; '))}</span></td>
            <td>${formatDateTime(r.completed_at)}</td>
            <td>
                <div class="btn-group btn-group-sm">
                    <button class="btn btn-outline-info" data-action="viewResult" data-action-args='[${r.id}]' title="${t('tests.view')}"><i class="bi bi-eye"></i></button>
                    <button class="btn btn-outline-secondary" data-action="downloadStudentReport" data-action-args='[${r.user_id}]' title="${t('report.download')}"><i class="bi bi-file-earmark-pdf"></i></button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderCharts(groups, students) {
    // Бар-чарт: студенты vs прошедшие по группам
    const ctx1 = document.getElementById('groupsChart');
    if (ctx1 && window.Chart) {
        if (groupsChart) groupsChart.destroy();
        groupsChart = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: groups.map(g => g.group_name || '—'),
                datasets: [
                    { label: t('table.students'), data: groups.map(g => parseInt(g.total_students) || 0), backgroundColor: '#4361ee', borderRadius: 6 },
                    { label: t('table.passed'), data: groups.map(g => parseInt(g.completed_tests) || 0), backgroundColor: '#06d6a0', borderRadius: 6 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
            }
        });
    }
}

async function loadStudents() {
    try {
        const params = new URLSearchParams();
        const search = document.getElementById('searchStudent')?.value;
        const group = document.getElementById('filterGroup')?.value;

        if (search) params.append('search', search);
        if (group) params.append('group', group);

        const res = await fetch(`/api/students?${params}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const studentsRaw = await res.json();
        const students = Array.isArray(studentsRaw) ? studentsRaw : (studentsRaw?.data || []);
        adminStudentsCache = students;
        resetAdminUserSelection('student');

        const tbody = document.getElementById('studentsTableBody');
        if (students.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-muted">${t('students.not_found')}</td></tr>`;
            return;
        }

        tbody.innerHTML = students.map(s => `
            <tr>
                <td class="selection-column">
                    <input class="form-check-input" type="checkbox" data-user-select="student"
                           data-action="toggleUserSelection" data-action-args='["student",${s.id}]'
                           data-action-event="change" data-action-pass="element"
                           aria-label="${t('users.selected')}: ${esc(s.full_name)}">
                </td>
                <td class="fw-semibold">${esc(s.full_name)}</td>
                <td>${formatDate(s.birth_date)}</td>
                <td>${s.age != null ? s.age + ' ' + t('unit.years') : '-'}</td>
                <td>${esc(s.group_name || '-')}</td>
                <td>${esc(s.school || '-')}</td>
                <td>
                    <div class="btn-group btn-group-sm">
                        <button class="btn btn-outline-secondary" data-action="downloadStudentReport" data-action-args='[${s.id}]' title="${t('report.download')}">
                            <i class="bi bi-file-earmark-pdf"></i>
                        </button>
                        <button class="btn btn-outline-primary" data-action="editStudent" data-action-args='[${s.id}]' title="${t('common.edit')}">
                            <i class="bi bi-pencil"></i>
                        </button>
                        <button class="btn btn-outline-warning" data-action="openResetStudentPassword" data-action-args='[${s.id}]' title="${t('pw.reset_student')}">
                            <i class="bi bi-key"></i>
                        </button>
                        <button class="btn btn-outline-danger" data-action="deleteStudent" data-action-args='[${s.id}]' title="${t('common.delete')}">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        adminStudentsCache = [];
        resetAdminUserSelection('student');
        console.error(e);
    }
}

let editingStudentId = null;

async function openStudentModal(studentId = null) {
    editingStudentId = studentId;
    const form = document.getElementById('studentForm');
    form.reset();

    const cred = document.getElementById('credFields');
    const usernameInput = form.querySelector('[name="username"]');
    const passwordInput = form.querySelector('[name="password"]');

    document.getElementById('studentModalTitle').textContent =
        studentId ? t('smodal.edit_title') : t('smodal.add_title');

    if (studentId) {
        // В режиме редактирования логин/пароль не меняются — скрываем
        cred.classList.add('d-none');
        usernameInput.required = false;
        passwordInput.required = false;
        await fillStudentForm(studentId);
    } else {
        cred.classList.remove('d-none');
        usernameInput.required = true;
        passwordInput.required = false;
    }

    new bootstrap.Modal(document.getElementById('studentModal')).show();
}

function editStudent(id) {
    openStudentModal(id);
}

async function fillStudentForm(studentId) {
    try {
        const res = await fetch('/api/students', { headers: { 'Authorization': `Bearer ${token}` } });
        const raw = await res.json();
        const list = Array.isArray(raw) ? raw : (raw?.data || []);
        const s = list.find(x => x.id === studentId);
        if (!s) return;

        const form = document.getElementById('studentForm');
        form.full_name.value = s.full_name || '';
        form.birth_date.value = (s.birth_date || '').toString().slice(0, 10);
        form.group_name.value = s.group_name || '';
        form.school.value = s.school || '';
        form.email.value = s.email || '';
        form.phone.value = s.phone || '';
        form.home_address.value = s.home_address || '';
        form.family_type.value = s.family_type || 'full';
        form.lives_with.value = s.lives_with || '';
    } catch (e) { console.error(e); }
}

document.getElementById('studentForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const formData = new FormData(this);
    const data = Object.fromEntries(formData.entries());

    try {
        const url = editingStudentId ? `/api/students/${editingStudentId}` : '/api/students';
        const method = editingStudentId ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        if (!res.ok) throw new Error(await res.text());

        bootstrap.Modal.getInstance(document.getElementById('studentModal')).hide();
        loadStudents();
        loadDashboardStats();
        alert(editingStudentId ? t('msg.student_updated') : t('msg.student_added'));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
});

async function deleteStudent(id) {
    if (!confirm(t('msg.confirm_delete_student'))) return;

    try {
        const res = await fetch(`/api/students/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || t('msg.delete_error'));
        }
        loadStudents();
        loadDashboardStats();
    } catch (e) { alert(t('msg.delete_error') + ': ' + e.message); }
}

async function runSelectedAdminUserAction(role, action, newPassword = null) {
    const config = adminUserSelectionConfig(role);
    const userIds = [...config.selected];
    if (userIds.length === 0) {
        alert(t('users.choose_first'));
        return false;
    }
    const res = await fetch('/api/users/bulk', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ userIds, action, newPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('msg.error'));
    if (role === 'curator') await loadCurators();
    else {
        await loadStudents();
        loadDashboardStats();
    }
    return true;
}

async function deactivateSelectedUsers(role) {
    const config = adminUserSelectionConfig(role);
    if (config.selected.size === 0) {
        alert(t('users.choose_first'));
        return;
    }
    if (!confirm(t('users.confirm_deactivate'))) return;
    try {
        const completed = await runSelectedAdminUserAction(role, 'deactivate');
        if (completed) alert(t('users.deactivated'));
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

// ========== ИМПОРТ СТУДЕНТОВ ИЗ EXCEL ==========
const IMPORT_HEADER_MAP = {
    'логин': 'username',
    'пароль': 'password',
    'фио': 'full_name',
    'дата рождения': 'birth_date',
    'группа': 'group_name',
    'школа окончания': 'school',
    'школа': 'school',
    'email': 'email',
    'почта': 'email',
    'эл. почта': 'email',
    'телефон': 'phone',
    'домашний адрес': 'home_address',
    'адрес': 'home_address',
    'тип семьи': 'family_type',
    'с кем проживает': 'lives_with',
    'проживает с': 'lives_with'
};

function parseFamilyType(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return 'full';
    if (['full', 'single_parent', 'guardian', 'other'].includes(s)) return s;
    if (s.startsWith('полн')) return 'full';
    if (s.startsWith('неполн')) return 'single_parent';
    if (s.startsWith('опек')) return 'guardian';
    if (s.startsWith('друг')) return 'other';
    return 'full';
}

function normalizeDate(v) {
    if (v == null || v === '') return null;
    const fmt = (d) => {
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        return `${y}-${mo}-${da}`;
    };
    if (v instanceof Date && !isNaN(v)) return fmt(v);
    if (typeof v === 'number') {
        const d = new Date(Math.round((v - 25569) * 86400000));
        return isNaN(d) ? null : fmt(d);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(s);
    return isNaN(d) ? null : fmt(d);
}

async function importStudents(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });

        const students = rows.map(row => {
            const obj = {};
            for (const key in row) {
                const norm = String(key).trim().toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();
                const field = IMPORT_HEADER_MAP[norm];
                if (field) obj[field] = row[key];
            }
            if (obj.birth_date != null) obj.birth_date = normalizeDate(obj.birth_date);
            if (obj.family_type != null && obj.family_type !== '') obj.family_type = parseFamilyType(obj.family_type);
            for (const k in obj) if (typeof obj[k] === 'string') obj[k] = obj[k].trim();
            return obj;
        }).filter(o => String(o.username || '').trim());

        if (students.length === 0) {
            alert(t('msg.import_no_login'));
            event.target.value = '';
            return;
        }

        const res = await fetch('/api/students/import', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ students })
        });

        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Ошибка импорта');

        let msg = `${t('msg.import_done')}: ${result.created} ${t('msg.import_of')} ${result.total}.`;
        if (result.errors && result.errors.length) {
            msg += `\n\n${t('msg.import_skipped')} (${result.errors.length}):\n` + result.errors.slice(0, 15).join('\n');
            if (result.errors.length > 15) msg += `\n... ${t('msg.import_more')} ${result.errors.length - 15}`;
        }
        if (Array.isArray(result.generatedCredentials) && result.generatedCredentials.length) {
            const credentialsSheet = XLSX.utils.json_to_sheet(
                result.generatedCredentials.map(item => ({
                    'Логин': item.username,
                    'Временный пароль': item.password
                }))
            );
            credentialsSheet['!cols'] = [{ wch: 24 }, { wch: 28 }];
            const credentialsBook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(credentialsBook, credentialsSheet, 'Пароли');
            XLSX.writeFile(
                credentialsBook,
                `initial-passwords-${new Date().toISOString().split('T')[0]}.xlsx`
            );
            msg += `\n\n${t('msg.generated_passwords')}: ${result.generatedCredentials.length}`;
        }
        alert(msg);

        loadStudents();
        loadDashboardStats();
    } catch (e) {
        alert(t('msg.import_error') + ': ' + e.message);
    } finally {
        event.target.value = '';
    }
}

function downloadTemplate() {
    const headers = ['Логин', 'Пароль', 'ФИО', 'Дата рождения', 'Группа', 'Школа окончания',
        'Email', 'Телефон', 'Домашний адрес', 'Тип семьи', 'С кем проживает'];
    const example = ['ivanov', '', 'Иванов Иван Иванович', '2008-05-15', 'ПО-41', '№123 г. Алматы',
        'ivanov@mail.kz', '+7 700 000 00 00', 'ул. Абая, д. 1, кв. 2', 'Полная', 'Мама, папа'];
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    ws['!cols'] = headers.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Студенты');
    XLSX.writeFile(wb, 'shablon_studentov.xlsx');
}

async function loadTests() {
    try {
        const res = await fetch('/api/questionnaires', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const testsRaw = await res.json();
        const tests = Array.isArray(testsRaw) ? testsRaw : (testsRaw?.data || []);
        adminTestsCache = tests;

        const container = document.getElementById('testsList');
        if (tests.length === 0) {
            container.innerHTML = `<div class="col-12 text-center text-muted py-5">${t('tests.empty')}</div>`;
            return;
        }

        container.innerHTML = tests.map(item => `
            <div class="col-md-6 col-lg-4">
                <div class="card h-100 test-card">
                    <div class="card-body">
                        <h5 class="card-title">${esc(item.title)}</h5>
                        <p class="card-text text-muted small">${esc(item.description || '')}</p>
                        <div class="d-flex justify-content-between align-items-center mt-3">
                            <span class="badge bg-primary">${item.questions_count} ${t('tests.q_count')}</span>
                            <small class="text-muted">${formatDate(item.created_at)}</small>
                        </div>
                    </div>
                    <div class="card-footer bg-transparent border-top-0">
                        <div class="d-grid gap-2">
                            <button class="btn btn-sm btn-outline-success" data-action="openAssignModal" data-action-args='[${item.id}]'>
                                <i class="bi bi-person-plus me-1"></i>${t('tests.assign')}
                            </button>
                            <button class="btn btn-sm btn-outline-primary" data-action="viewTest" data-action-args='[${item.id}]'>
                                <i class="bi bi-eye me-1"></i>${t('tests.view')}
                            </button>
                            <button class="btn btn-sm btn-outline-danger" data-action="deleteTest" data-action-args='[${item.id}]'>
                                <i class="bi bi-trash me-1"></i>${t('common.delete')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) { console.error(e); }
}

async function viewTest(id) {
    try {
        const res = await fetch(`/api/questionnaires/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const q = await res.json();
        const questions = Array.isArray(q.questions) ? q.questions : [];
        const body = document.getElementById('resultModalBody');
        body.innerHTML = `
            <h5>${esc(q.title)}</h5>
            <p class="text-muted">${esc(q.description || '')}</p>
            <hr>
            <ol class="ps-3">
                ${questions.map(qq => `<li class="mb-2">${esc(qq.question_text)} <span class="badge bg-light text-dark">${esc(qq.question_type)}</span></li>`).join('')}
            </ol>
        `;
        new bootstrap.Modal(document.getElementById('resultModal')).show();
    } catch (e) { alert(t('msg.test_load_error')); }
}

async function deleteTest(id) {
    const selected = adminTestsCache.find(item => item.id === id);
    const title = selected ? selected.title : '';
    if (!confirm(`${t('msg.confirm_delete_test')}${title ? '\n\n«' + title + '»' : ''}`)) return;
    try {
        const res = await fetch(`/api/questionnaires/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        loadTests();
        loadTestsForFilter();
        loadDashboardStats();
        alert(t('msg.test_deleted'));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

let questionCounter = 0;
let currentMethodology = null;

function populateMethodologySelect() {
    const select = document.getElementById('methodologySelect');
    if (!select) return;
    const all = window.allMethodologies ? window.allMethodologies() : (window.PSY_METHODOLOGIES || []);
    select.innerHTML = `<option value="">${t('tmodal.custom_test')}</option>` +
        all.map(m => `<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('');
}

function onMethodologyChange() {
    const select = document.getElementById('methodologySelect');
    const form = document.getElementById('testForm');
    const builder = document.getElementById('manualBuilder');
    const preview = document.getElementById('methodologyPreview');
    currentMethodology = window.findMethodologyById ? window.findMethodologyById(select.value) : null;

    if (currentMethodology) {
        const m = currentMethodology;
        form.title.value = m.title;
        form.description.value = m.description || '';
        form.title.readOnly = true;
        form.description.readOnly = true;
        builder.classList.add('d-none');
        // Убираем поля ручного конструктора: скрытые required-инпуты иначе
        // блокируют отправку формы (валидация не может сфокусировать скрытое поле)
        document.getElementById('questionsContainer').innerHTML = '';
        preview.classList.remove('d-none');
        const maxScoreLabel = m.maxScore != null
            ? m.maxScore
            : (Array.isArray(m.scales)
                ? m.scales.map(scale => scale.maxScore).filter(value => value != null).join(' / ')
                : '—');
        preview.innerHTML = `
            <div class="alert alert-light border">
                <strong>${t('tmodal.instruction')}:</strong> ${esc(m.instruction || '')}
            </div>
            <p class="text-muted small mb-2">
                ${t('tmodal.answer_options')}: ${(m.answerOptions || []).map(o => `${esc(o.text)} = ${Number(o.score)}`).join(', ')}
                &middot; ${t('tests.q_count')}: ${m.questions.length}
                &middot; ${t('tmodal.max_score')}: ${esc(maxScoreLabel)}
            </p>
            <ol class="ps-3">${m.questions.map(q => `<li class="mb-1">${esc(q && typeof q === 'object' ? q.text : q)}</li>`).join('')}</ol>
        `;
    } else {
        form.title.readOnly = false;
        form.description.readOnly = false;
        builder.classList.remove('d-none');
        preview.classList.add('d-none');
        preview.innerHTML = '';
        if (document.getElementById('questionsContainer').children.length === 0) {
            questionCounter = 0;
            addQuestion();
        }
    }
}

function openTestModal() {
    questionCounter = 0;
    currentMethodology = null;
    const form = document.getElementById('testForm');
    form.reset();
    form.title.readOnly = false;
    form.description.readOnly = false;
    document.getElementById('manualBuilder').classList.remove('d-none');
    document.getElementById('methodologyPreview').classList.add('d-none');
    document.getElementById('questionsContainer').innerHTML = '';
    populateMethodologySelect();
    document.getElementById('methodologySelect').value = '';
    addQuestion();
    new bootstrap.Modal(document.getElementById('testModal')).show();
}

function addQuestion() {
    const container = document.getElementById('questionsContainer');
    const qNum = ++questionCounter;

    const questionHtml = `
        <div class="card mb-3 question-card" id="question-${qNum}">
            <div class="card-header d-flex justify-content-between align-items-center py-2">
                <span class="fw-bold">${t('q.label')} ${qNum}</span>
                <div class="d-flex gap-2">
                    <select class="form-select form-select-sm" style="width:auto;" data-action="updateQuestionType" data-action-args='[${qNum}]' data-action-event="change" data-action-pass="value">
                        <option value="single">${t('q.single')}</option>
                        <option value="multiple">${t('q.multiple')}</option>
                        <option value="scale">${t('q.scale')}</option>
                        <option value="text">${t('q.text')}</option>
                    </select>
                    <button type="button" class="btn btn-sm btn-outline-danger" data-action="removeQuestion" data-action-args='[${qNum}]'>
                        <i class="bi bi-x-lg"></i>
                    </button>
                </div>
            </div>
            <div class="card-body">
                <div class="mb-3">
                    <input type="text" class="form-control" name="questions[${qNum}][questionText]"
                           placeholder="${t('q.text_ph')}" required>
                </div>
                <div class="question-options" id="options-${qNum}">
                    <label class="form-label small">${t('q.options')}</label>
                    <div class="options-list">
                        <div class="input-group input-group-sm mb-2">
                            <input type="text" class="form-control option-input" placeholder="1">
                            <button type="button" class="btn btn-outline-secondary" data-action="addOption" data-action-pass="element">+</button>
                        </div>
                        <div class="input-group input-group-sm mb-2">
                            <input type="text" class="form-control option-input" placeholder="2">
                            <button type="button" class="btn btn-outline-secondary" data-action="addOption" data-action-pass="element">+</button>
                        </div>
                    </div>
                </div>
                <div class="scale-options d-none" id="scale-${qNum}">
                    <div class="row g-2">
                        <div class="col-3">
                            <label class="form-label small">${t('q.min')}</label>
                            <input type="number" class="form-control form-control-sm" value="1" name="questions[${qNum}][scaleMin]">
                        </div>
                        <div class="col-3">
                            <label class="form-label small">${t('q.max')}</label>
                            <input type="number" class="form-control form-control-sm" value="5" name="questions[${qNum}][scaleMax]">
                        </div>
                    </div>
                </div>
                <div class="form-check mt-2">
                    <input class="form-check-input" type="checkbox" checked name="questions[${qNum}][isRequired]">
                    <label class="form-check-label small">${t('q.required')}</label>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', questionHtml);
}

function removeQuestion(qNum) {
    document.getElementById(`question-${qNum}`).remove();
}

function updateQuestionType(qNum, type) {
    const optionsDiv = document.getElementById(`options-${qNum}`);
    const scaleDiv = document.getElementById(`scale-${qNum}`);

    if (type === 'scale') {
        optionsDiv.classList.add('d-none');
        scaleDiv.classList.remove('d-none');
    } else if (type === 'text') {
        optionsDiv.classList.add('d-none');
        scaleDiv.classList.add('d-none');
    } else {
        optionsDiv.classList.remove('d-none');
        scaleDiv.classList.add('d-none');
    }
}

function addOption(btn) {
    const list = btn.closest('.options-list');
    const count = list.querySelectorAll('.input-group').length + 1;
    const newOpt = document.createElement('div');
    newOpt.className = 'input-group input-group-sm mb-2';
    newOpt.innerHTML = `
        <input type="text" class="form-control option-input" placeholder="${count}">
        <button type="button" class="btn btn-outline-secondary" data-action="addOption" data-action-pass="element">+</button>
        <button type="button" class="btn btn-outline-danger" data-remove-closest=".input-group">×</button>
    `;
    list.appendChild(newOpt);
}

document.getElementById('testForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    let title, description, questions;

    if (currentMethodology) {
        // Готовая методика: вопросы и веса вариантов берём из определения методики.
        // Вопрос может быть строкой ИЛИ объектом { text, scale, reverse, options }.
        const m = currentMethodology;
        title = m.title;
        description = m.description || '';
        questions = m.questions.map(q => {
            const text = (q && typeof q === 'object') ? q.text : q;
            const options = (q && typeof q === 'object' && q.options) ? q.options : m.answerOptions;
            return { questionText: text, questionType: 'single', options: options, isRequired: true };
        });
    } else {
        title = this.title.value;
        description = this.description.value;
        questions = [];

        document.querySelectorAll('.question-card').forEach((card) => {
            const qType = card.querySelector('select').value;
            const qText = card.querySelector('input[name*="questionText"]').value;
            const isRequired = card.querySelector('[name*="isRequired"]')?.checked ?? true;

            let options = [];
            if (qType === 'single' || qType === 'multiple') {
                card.querySelectorAll('.option-input').forEach(input => {
                    if (input.value.trim()) options.push(input.value.trim());
                });
            }

            questions.push({
                questionText: qText,
                questionType: qType,
                options: options,
                scaleMin: card.querySelector('[name*="scaleMin"]')?.value || 1,
                scaleMax: card.querySelector('[name*="scaleMax"]')?.value || 5,
                isRequired: isRequired
            });
        });
    }

    if (questions.length === 0 || !title) {
        alert(t('msg.test_fill'));
        return;
    }

    try {
        const res = await fetch('/api/questionnaires', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title,
                description,
                questions,
                methodology: currentMethodology || null
            })
        });

        if (!res.ok) throw new Error(await res.text());

        bootstrap.Modal.getInstance(document.getElementById('testModal')).hide();
        loadTests();
        loadTestsForFilter();
        alert(t('msg.test_created'));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
});

async function openAssignModal(testId) {
    document.getElementById('assignQuestionnaireId').value = testId;

    const res = await fetch('/api/students', { headers: { 'Authorization': `Bearer ${token}` }});
    const studentsRaw = await res.json();
    const students = Array.isArray(studentsRaw) ? studentsRaw : (studentsRaw?.data || []);

    const list = document.getElementById('assignStudentsList');

    if (students.length === 0) {
        list.innerHTML = `<p class="text-muted mb-0">${t('students.not_found')}</p>`;
        new bootstrap.Modal(document.getElementById('assignModal')).show();
        return;
    }

    // Группируем студентов по группе
    const groups = {};
    students.forEach(s => {
        const g = s.group_name || t('amodal.no_group');
        (groups[g] = groups[g] || []).push(s);
    });

    let html = `
        <div class="form-check border-bottom pb-2 mb-2">
            <input class="form-check-input" type="checkbox" id="assignSelectAll" data-action="toggleAllAssign" data-action-event="change" data-action-pass="element">
            <label class="form-check-label fw-bold" for="assignSelectAll">${t('amodal.select_all')}</label>
        </div>`;

    Object.keys(groups).sort().forEach((g, gi) => {
        html += `
            <div class="mb-2">
                <div class="form-check">
                    <input class="form-check-input assign-group-toggle" type="checkbox"
                           id="assignGroup${gi}" data-group="${gi}" data-action="toggleGroupAssign" data-action-event="change" data-action-pass="element">
                    <label class="form-check-label fw-semibold text-primary" for="assignGroup${gi}">
                        <i class="bi bi-people me-1"></i>${esc(g)} (${groups[g].length})
                    </label>
                </div>
                <div class="ms-4">
                    ${groups[g].map(s => `
                        <div class="form-check">
                            <input class="form-check-input assign-student" type="checkbox" value="${s.id}"
                                   id="student-${s.id}" name="userIds" data-group="${gi}" data-action="syncGroupToggle" data-action-args='[${gi}]' data-action-event="change">
                            <label class="form-check-label" for="student-${s.id}">
                                ${esc(s.full_name)}${s.age != null ? ' (' + s.age + ' ' + t('unit.years') + ')' : ''}
                            </label>
                        </div>
                    `).join('')}
                </div>
            </div>`;
    });

    list.innerHTML = html;
    new bootstrap.Modal(document.getElementById('assignModal')).show();
}

function toggleAllAssign(master) {
    document.querySelectorAll('#assignStudentsList .assign-student, #assignStudentsList .assign-group-toggle')
        .forEach(cb => cb.checked = master.checked);
}

function toggleGroupAssign(groupCb) {
    const g = groupCb.dataset.group;
    document.querySelectorAll(`#assignStudentsList .assign-student[data-group="${g}"]`)
        .forEach(cb => cb.checked = groupCb.checked);
}

// Синхронизирует чекбокс группы при ручном выборе её студентов
function syncGroupToggle(gi) {
    const studentCbs = document.querySelectorAll(`#assignStudentsList .assign-student[data-group="${gi}"]`);
    const groupCb = document.getElementById('assignGroup' + gi);
    if (!groupCb) return;
    groupCb.checked = studentCbs.length > 0 && [...studentCbs].every(cb => cb.checked);
}

document.getElementById('assignForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const checkboxes = this.querySelectorAll('input[name="userIds"]:checked');
    const userIds = Array.from(checkboxes).map(cb => parseInt(cb.value));

    if (userIds.length === 0) {
        alert(t('msg.select_student'));
        return;
    }

    try {
        const res = await fetch('/api/assign-test', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                questionnaireId: parseInt(this.questionnaireId.value),
                userIds,
                dueDate: this.dueDate.value || null
            })
        });

        if (!res.ok) throw new Error(await res.text());

        bootstrap.Modal.getInstance(document.getElementById('assignModal')).hide();
        const data = await res.json();
        alert(t('msg.test_assigned') + ': ' + (data.assigned ?? userIds.length) +
            (data.skipped ? `; ${t('msg.skipped')}: ${data.skipped}` : ''));
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
});

async function loadTestsForFilter() {
    try {
        const res = await fetch('/api/questionnaires', { headers: { 'Authorization': `Bearer ${token}` }});
        const testsRaw = await res.json();
        const tests = Array.isArray(testsRaw) ? testsRaw : (testsRaw?.data || []);

        const select = document.getElementById('resultTest');
        if (select) {
            select.innerHTML = `<option value="">${t('common.all_tests')}</option>` +
                tests.map(item => `<option value="${item.id}">${esc(item.title)}</option>`).join('');
        }
    } catch (e) {}
}

function resultQueryParams(includeGroup = true) {
    const params = new URLSearchParams();
    const values = {
        groupId: document.getElementById('resultGroup')?.value,
        questionnaireId: document.getElementById('resultTest')?.value,
        startDate: document.getElementById('dateFrom')?.value,
        endDate: document.getElementById('dateTo')?.value,
        search: document.getElementById('resultSearch')?.value?.trim(),
        level: document.getElementById('resultLevel')?.value,
        risk: document.getElementById('resultRisk')?.value
    };
    Object.entries(values).forEach(([key, value]) => {
        if (value && (includeGroup || key !== 'groupId')) params.append(key, value);
    });
    return params;
}

function resetResultFilters() {
    ['resultGroup', 'resultTest', 'dateFrom', 'dateTo', 'resultSearch', 'resultLevel', 'resultRisk']
        .forEach(id => {
            const element = document.getElementById(id);
            if (element) element.value = '';
        });
    loadResults();
}

async function loadResults() {
    try {
        const params = resultQueryParams();

        const res = await fetch(`/api/results?${params}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        const resultsRaw = await res.json();
        const results = Array.isArray(resultsRaw) ? resultsRaw : (resultsRaw?.data || []);

        renderResultsInfographics(results);

        const tbody = document.getElementById('resultsTableBody');
        if (results.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">${t('results.not_found')}</td></tr>`;
            return;
        }

        tbody.innerHTML = results.map(r => `
            <tr>
                <td class="fw-semibold">${esc(r.full_name)}</td>
                <td>${esc(r.group_name || '-')}</td>
                <td>${esc(r.questionnaire_title)}</td>
                <td>
                    <span class="badge ${scoreBadgeFor(r)}">${r.score}</span>
                    ${interpLabelFor(r) ? `<div class="small text-muted mt-1">${esc(interpLabelFor(r))}</div>` : ''}
                </td>
                <td>${formatDateTime(r.completed_at)}</td>
                <td>
                    <div class="btn-group btn-group-sm">
                        <button class="btn btn-outline-info" data-action="viewResult" data-action-args='[${r.id}]' title="${t('tests.view')}">
                            <i class="bi bi-eye"></i>
                        </button>
                        <button class="btn btn-outline-danger" data-action="deleteResult" data-action-args='[${r.id}]' title="${t('common.delete')}">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (e) { console.error(e); }
}

let resLevelsChart = null;
let resTestsChart = null;

function shortText(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const methFor = methodologyForResult;

// Инфографика строится ПОЛНОСТЬЮ из данных методик (methodologies.js),
// без предположений о числе/названиях уровней — масштабируется на любые методики.
function renderResultsInfographics(results) {
    const arr = Array.isArray(results) ? results : [];

    const total = arr.length;
    const students = new Set(arr.map(r => r.user_id)).size;
    const testTitles = new Set(arr.map(r => r.questionnaire_title).filter(Boolean));
    const scores = arr.map(r => parseFloat(r.score)).filter(n => !isNaN(n));
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    document.getElementById('resTotal').textContent = total;
    document.getElementById('resStudents').textContent = students;
    document.getElementById('resTests').textContent = testTitles.size;
    document.getElementById('resAvg').textContent = scores.length ? avg.toFixed(1) : '—';

    if (!window.Chart) return;

    // --- Доунат: распределение по уровням интерпретации ---
    // Если в выборке несколько методик — к подписи добавляем название теста,
    // чтобы одинаковые названия уровней из разных методик не смешивались.
    const methTitles = new Set();
    arr.forEach(r => { const m = methFor(r); if (m) methTitles.add(m.title); });
    const multiMeth = methTitles.size > 1;

    // Цвета: приоритет — заданный в методике range.color; затем семантика
    // для типовых уровней; затем палитра по кругу (для любых нестандартных уровней).
    const PALETTE = ['#4361ee', '#06d6a0', '#ffd166', '#ef476f', '#118ab2', '#9b5de5', '#f15bb5', '#00bbf9', '#fb8500'];
    let paletteIdx = 0;
    const buckets = new Map(); // label -> { count, color }

    arr.forEach(r => {
        const m = methFor(r);
        const range = interpForResult(r);
        let label, color;
        if (range) {
            label = multiMeth ? `${shortText(m.title, 22)}: ${range.label}` : range.label;
            color = range.color || (range.attention ? '#ef476f' : range.level === 'medium' ? '#ffd166' : '#06d6a0');
        } else {
            label = t('level.none');
            color = '#adb5bd';
        }
        if (!buckets.has(label)) {
            if (!color) color = PALETTE[paletteIdx++ % PALETTE.length];
            buckets.set(label, { count: 0, color });
        }
        buckets.get(label).count++;
    });

    const levelLabels = [...buckets.keys()];
    const ctxL = document.getElementById('resLevelsChart');
    if (ctxL) {
        if (resLevelsChart) resLevelsChart.destroy();
        resLevelsChart = new Chart(ctxL, {
            type: 'doughnut',
            data: {
                labels: levelLabels,
                datasets: [{
                    data: levelLabels.map(k => buckets.get(k).count),
                    backgroundColor: levelLabels.map(k => buckets.get(k).color),
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
    }

    // --- Горизонтальный бар: средний балл по тестам ---
    const byTest = {};
    arr.forEach(r => {
        const s = parseFloat(r.score);
        if (isNaN(s)) return;
        const key = r.questionnaire_title || '—';
        (byTest[key] = byTest[key] || []).push(s);
    });
    const testNames = Object.keys(byTest);
    const testAvgs = testNames.map(k => +(byTest[k].reduce((a, b) => a + b, 0) / byTest[k].length).toFixed(1));

    const ctxT = document.getElementById('resTestsChart');
    if (ctxT) {
        if (resTestsChart) resTestsChart.destroy();
        resTestsChart = new Chart(ctxT, {
            type: 'bar',
            data: {
                labels: testNames.map(n => shortText(n, 40)),
                datasets: [{
                    label: t('res.avg_score'),
                    data: testAvgs,
                    backgroundColor: '#4361ee',
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
            }
        });
    }
}

function getScoreBadge(score) {
    if (score >= 4) return 'bg-danger';
    if (score >= 3) return 'bg-warning text-dark';
    return 'bg-success';
}

// Интерпретация результата по методике (главная шкала).
// Считаем через единый движок по сырым ответам — корректно для подшкал
// и обратных вопросов; если ответов нет — откат на сохранённый балл.
function interpForResult(r) {
    const m = methFor(r);
    if (!m) return null;
    if (window.scoreMethodology && r.answers) {
        const sc = window.scoreMethodology(m, r.answers);
        return sc.primary ? sc.primary.interp : null;
    }
    return window.interpretMethodology(m, r.score);
}
function interpLabelFor(r) {
    const i = interpForResult(r);
    return i ? i.label : '';
}
function scoreBadgeFor(r) {
    const i = interpForResult(r);
    if (i) {
        return i.attention ? 'bg-danger'
            : i.level === 'medium' ? 'bg-warning text-dark'
            : 'bg-success';
    }
    return getScoreBadge(r.score);
}

async function deleteResult(id) {
    if (!confirm(t('msg.confirm_delete_result'))) return;
    try {
        const res = await fetch(`/api/results/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        loadResults();
        loadDashboardStats();
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

async function viewResult(resultId) {
    try {
        const res = await fetch('/api/results', { headers: { 'Authorization': `Bearer ${token}` }});
        const resultsRaw = await res.json();
        const results = Array.isArray(resultsRaw) ? resultsRaw : (resultsRaw?.data || []);

        const result = results.find(r => r.id === resultId);
        if (!result) return;

        const meth = methodologyForResult(result);
        const sc = (meth && window.scoreMethodology) ? window.scoreMethodology(meth, result.answers || {}) : null;

        const badgeClass = (range) => range.attention
            ? 'bg-danger'
            : range.level === 'medium' ? 'bg-warning text-dark' : 'bg-success';

        let summaryHtml, breakdownHtml = '';
        if (sc) {
            // Предупреждения шкал достоверности
            breakdownHtml += sc.validity.filter(v => v.failed).map(v => `
                <div class="alert alert-warning py-2 mb-2">
                    <i class="bi bi-exclamation-triangle me-1"></i>${esc(v.warning || v.name)} (${v.value})
                </div>`).join('');
            // Таблица по шкалам
            breakdownHtml += `
                <table class="table table-sm align-middle">
                    <thead><tr><th>${t('rmodal.scale')}</th><th>${t('table.score')}</th><th>${t('rmodal.interpretation')}</th></tr></thead>
                    <tbody>
                        ${sc.scales.filter(s => s.display !== false).map(s => `
                            <tr>
                                <td>${esc(s.name)}</td>
                                <td><span class="badge ${s.interp ? badgeClass(s.interp) : 'bg-secondary'}">${s.raw}${s.maxScore != null ? ' / ' + s.maxScore : ''}</span></td>
                                <td>${s.interp ? esc(s.interp.label) : '—'}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>`;
            summaryHtml = `<p class="text-muted mb-2">${t('table.test')}: ${esc(result.questionnaire_title)}</p>`;
        } else {
            summaryHtml = `<p class="text-muted">${t('table.test')}: ${esc(result.questionnaire_title)} | ${t('table.score')}: <strong>${result.score}</strong></p>`;
        }

        const body = document.getElementById('resultModalBody');
        body.innerHTML = `
            <div class="d-flex justify-content-between align-items-start">
                <h5>${esc(result.full_name)}</h5>
                <button class="btn btn-sm btn-outline-secondary" data-action="downloadResultReport" data-action-args='[${result.id}]'>
                    <i class="bi bi-file-earmark-pdf me-1"></i>${t('report.download')}
                </button>
            </div>
            ${summaryHtml}
            ${breakdownHtml}
            <hr>
            <h6>${t('rmodal.answers')}</h6>
            <div class="table-responsive">
                <table class="table table-sm">
                    <thead><tr><th>#</th><th>${t('rmodal.answers')}</th></tr></thead>
                    <tbody>
                        ${Object.entries(result.answers || {}).map(([key, val]) => `
                            <tr><td>${parseInt(key) + 1}</td><td>${esc(Array.isArray(val) ? val.join(', ') : val)}</td></tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;

        new bootstrap.Modal(document.getElementById('resultModal')).show();
    } catch (e) {}
}

// ========== PDF-ЗАКЛЮЧЕНИЯ ==========
function reportFamilyLabel(ft) {
    const map = { full: 'family.full', single_parent: 'family.single_parent', guardian: 'family.guardian', other: 'family.other' };
    return map[ft] ? t(map[ft]) : '—';
}

function buildStudentPdfDefinition(student, results) {
    const content = [
        { text: t('report.title'), style: 'title' },
        {
            text: new Date().toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU'),
            style: 'date'
        },
        window.PsyPdf.keyValueTable(
            [
                [t('table.fio'), student.full_name || '—'],
                [t('table.group'), student.group_name || '—'],
                [
                    t('table.birth_date'),
                    `${student.birth_date ? formatDate(student.birth_date) : '—'}${student.age != null ? ` (${student.age} ${t('unit.years')})` : ''}`
                ],
                [t('field.school'), student.school || '—'],
                [t('field.family_type'), reportFamilyLabel(student.family_type)],
                [t('field.lives_with'), student.lives_with || '—']
            ]
        ),
        { text: t('report.results'), style: 'section' }
    ];

    const byTest = new Map();
    results.forEach(result => {
        const title = result.questionnaire_title || '—';
        if (!byTest.has(title)) byTest.set(title, []);
        byTest.get(title).push(result);
    });

    if (!results.length) {
        content.push({ text: t('report.no_results'), color: '#667085' });
    }

    for (const [title, group] of byTest.entries()) {
        group.sort((a, b) => new Date(a.completed_at || 0) - new Date(b.completed_at || 0));
        content.push({ text: title, style: 'subsection' });
        if (group.length > 1) {
            const dynamics = group.map(result => {
                const methodology = methodologyForResult(result);
                const scored = methodology && window.scoreMethodology
                    ? window.scoreMethodology(methodology, result.answers || {})
                    : null;
                return scored && scored.primary ? scored.primary.raw : result.score;
            });
            content.push({ text: `${t('report.dynamics')}: ${dynamics.join(' → ')}`, style: 'meta' });
        }
        for (const result of group) {
            content.push({ text: `${t('table.date')}: ${formatDateTime(result.completed_at)}`, style: 'meta' });
            const methodology = methodologyForResult(result);
            const scored = methodology && window.scoreMethodology
                ? window.scoreMethodology(methodology, result.answers || {})
                : null;
            if (!scored) {
                content.push({ text: `${t('table.score')}: ${result.score}`, margin: [0, 0, 0, 5] });
                continue;
            }
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
        }
    }

    content.push(
        { text: `${t('report.notes')}: ________________________________________________`, margin: [0, 18, 0, 8] },
        {
            text: `${t('report.psychologist')}: ____________________ / ${currentUser.fullName || ''}`,
            style: 'signature'
        }
    );
    return window.PsyPdf.baseDefinition(content, { title: t('report.title') });
}

let summaryReportHtml = '';
let summaryReportData = null;

function riskInfoForResult(result) {
    if (typeof result.at_risk === 'boolean') {
        return {
            atRisk: result.at_risk,
            reasons: Array.isArray(result.risk_reasons) ? result.risk_reasons : []
        };
    }
    const methodology = methodologyForResult(result);
    return methodology && window.resultAttention
        ? window.resultAttention(methodology, result.answers || {})
        : { atRisk: false, reasons: [] };
}

function summaryLevelForResult(result) {
    if (result.interpretation_label) return result.interpretation_label;
    return interpLabelFor(result) || t('level.none');
}

function countUniqueStudents(results) {
    return new Set(results.map(result => result.user_id)).size;
}

function countRiskStudents(results) {
    return new Set(results.filter(result => riskInfoForResult(result).atRisk).map(result => result.user_id)).size;
}

function summaryFilterDescription(scope, groupName) {
    const parts = [];
    if (scope === 'group') parts.push(`${t('table.group')}: ${esc(groupName)}`);
    const testSelect = document.getElementById('resultTest');
    if (testSelect?.value) parts.push(`${t('table.test')}: ${esc(testSelect.selectedOptions[0]?.textContent || '')}`);
    const from = document.getElementById('dateFrom')?.value;
    const to = document.getElementById('dateTo')?.value;
    if (from || to) parts.push(`${t('report.period')}: ${esc(from || '…')} — ${esc(to || '…')}`);
    const search = document.getElementById('resultSearch')?.value?.trim();
    if (search) parts.push(`${t('report.student_search')}: ${esc(search)}`);
    const level = document.getElementById('resultLevel');
    if (level?.value) parts.push(`${t('report.level_filter')}: ${esc(level.selectedOptions[0]?.textContent || '')}`);
    const risk = document.getElementById('resultRisk');
    if (risk?.value) parts.push(`${t('risk.title')}: ${esc(risk.selectedOptions[0]?.textContent || '')}`);
    return parts.length ? parts.join(' · ') : t('report.all_data');
}

function buildSummaryReport(scope, students, results, groupName) {
    const title = scope === 'group'
        ? `${t('report.group_title')}: ${esc(groupName)}`
        : t('report.college_title');
    const diagnosed = countUniqueStudents(results);
    const riskStudents = countRiskStudents(results);
    const coverage = students.length ? Math.round(diagnosed * 100 / students.length) : 0;

    const byTest = new Map();
    results.forEach(result => {
        const key = result.questionnaire_title || '—';
        if (!byTest.has(key)) byTest.set(key, []);
        byTest.get(key).push(result);
    });
    const testRows = [...byTest.entries()].map(([testTitle, testResults]) => {
        const levels = new Map();
        testResults.forEach(result => {
            const label = summaryLevelForResult(result);
            levels.set(label, (levels.get(label) || 0) + 1);
        });
        const unique = countUniqueStudents(testResults);
        return `<tr>
            <td>${esc(testTitle)}</td>
            <td>${unique}</td>
            <td>${testResults.length}</td>
            <td>${students.length ? Math.round(unique * 100 / students.length) : 0}%</td>
            <td>${[...levels.entries()].map(([label, count]) => `${esc(label)}: ${count}`).join('<br>') || '—'}</td>
            <td>${countRiskStudents(testResults)}</td>
        </tr>`;
    }).join('');

    let scopeRows = '';
    if (scope === 'college') {
        const groups = [...new Set(students.map(student => student.group_name || '—'))].sort();
        scopeRows = `
            <h2>${t('report.by_groups')}</h2>
            <table class="report-table table table-sm">
                <thead><tr><th>${t('table.group')}</th><th>${t('table.students')}</th><th>${t('report.diagnosed')}</th><th>${t('res.total')}</th><th>${t('risk.title')}</th></tr></thead>
                <tbody>${groups.map(group => {
                    const groupStudents = students.filter(student => (student.group_name || '—') === group);
                    const groupResults = results.filter(result => (result.group_name || '—') === group);
                    return `<tr><td>${esc(group)}</td><td>${groupStudents.length}</td><td>${countUniqueStudents(groupResults)}</td><td>${groupResults.length}</td><td>${countRiskStudents(groupResults)}</td></tr>`;
                }).join('')}</tbody>
            </table>`;
    } else {
        scopeRows = `
            <h2>${t('report.students_list')}</h2>
            <table class="report-table table table-sm">
                <thead><tr><th>${t('table.student')}</th><th>${t('res.total')}</th><th>${t('table.date')}</th><th>${t('risk.title')}</th></tr></thead>
                <tbody>${students.slice().sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).map(student => {
                    const studentResults = results.filter(result => result.user_id === student.id);
                    const latest = studentResults.reduce((value, result) => {
                        const timestamp = new Date(result.completed_at || 0).getTime();
                        return timestamp > value ? timestamp : value;
                    }, 0);
                    const reasons = [...new Set(studentResults.flatMap(result =>
                        riskInfoForResult(result).reasons.map(reason => reason.label)
                    ))];
                    return `<tr><td>${esc(student.full_name)}</td><td>${studentResults.length}</td><td>${latest ? formatDateTime(new Date(latest).toISOString()) : '—'}</td><td>${reasons.length ? esc(reasons.join('; ')) : '—'}</td></tr>`;
                }).join('')}</tbody>
            </table>`;
    }

    const riskByStudent = new Map();
    results.forEach(result => {
        const risk = riskInfoForResult(result);
        if (!risk.atRisk) return;
        const current = riskByStudent.get(result.user_id) || { name: result.full_name, group: result.group_name, reasons: new Set() };
        risk.reasons.forEach(reason => current.reasons.add(reason.label));
        riskByStudent.set(result.user_id, current);
    });
    const riskRows = [...riskByStudent.values()].map(item =>
        `<tr><td>${esc(item.name)}</td><td>${esc(item.group || '—')}</td><td>${esc([...item.reasons].join('; '))}</td></tr>`
    ).join('');

    return `
        <h1>${title}</h1>
        <p class="date">${new Date().toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU')}</p>
        <p class="meta">${summaryFilterDescription(scope, groupName)}</p>
        <table class="info">
            <tr><td>${t('table.students')}</td><td>${students.length}</td></tr>
            <tr><td>${t('report.diagnosed')}</td><td>${diagnosed} (${coverage}%)</td></tr>
            <tr><td>${t('res.total')}</td><td>${results.length}</td></tr>
            <tr><td>${t('risk.title')}</td><td>${riskStudents}</td></tr>
        </table>
        <h2>${t('report.by_tests')}</h2>
        <table class="report-table table table-sm">
            <thead><tr><th>${t('table.test')}</th><th>${t('report.diagnosed')}</th><th>${t('res.total')}</th><th>${t('report.coverage')}</th><th>${t('res.chart_levels')}</th><th>${t('risk.title')}</th></tr></thead>
            <tbody>${testRows || `<tr><td colspan="6">${t('report.no_results')}</td></tr>`}</tbody>
        </table>
        ${scopeRows}
        <h2>${t('risk.title')}</h2>
        <table class="report-table table table-sm">
            <thead><tr><th>${t('table.student')}</th><th>${t('table.group')}</th><th>${t('risk.reason')}</th></tr></thead>
            <tbody>${riskRows || `<tr><td colspan="3">${t('risk.empty')}</td></tr>`}</tbody>
        </table>
        <div class="notes"><strong>${t('report.notes')}:</strong><div class="line"></div><div class="line"></div></div>
        <div class="sign">${t('report.psychologist')}: ____________________ / ${esc(currentUser.fullName || '')}</div>
    `;
}

function buildSummaryPdfDefinition(scope, students, results, groupName) {
    const title = scope === 'group'
        ? `${t('report.group_title')}: ${groupName}`
        : t('report.college_title');
    const diagnosed = countUniqueStudents(results);
    const riskStudents = countRiskStudents(results);
    const coverage = students.length ? Math.round(diagnosed * 100 / students.length) : 0;
    const filterHolder = document.createElement('textarea');
    filterHolder.innerHTML = summaryFilterDescription(scope, groupName);

    const content = [
        { text: title, style: 'title' },
        {
            text: new Date().toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU'),
            style: 'date'
        },
        { text: filterHolder.value, style: 'meta' },
        window.PsyPdf.keyValueTable(
            [
                [t('table.students'), students.length],
                [t('report.diagnosed'), `${diagnosed} (${coverage}%)`],
                [t('res.total'), results.length],
                [t('risk.title'), riskStudents]
            ],
            ['45%', '55%']
        ),
        { text: t('report.by_tests'), style: 'section' }
    ];

    const byTest = new Map();
    results.forEach(result => {
        const key = result.questionnaire_title || '—';
        if (!byTest.has(key)) byTest.set(key, []);
        byTest.get(key).push(result);
    });
    const testRows = [...byTest.entries()].map(([testTitle, testResults]) => {
        const levels = new Map();
        testResults.forEach(result => {
            const label = summaryLevelForResult(result);
            levels.set(label, (levels.get(label) || 0) + 1);
        });
        const unique = countUniqueStudents(testResults);
        return [
            testTitle,
            unique,
            testResults.length,
            `${students.length ? Math.round(unique * 100 / students.length) : 0}%`,
            [...levels.entries()].map(([label, count]) => `${label}: ${count}`).join('\n') || '—',
            countRiskStudents(testResults)
        ];
    });
    content.push(window.PsyPdf.table(
        [t('table.test'), t('report.diagnosed'), t('res.total'), t('report.coverage'), t('res.chart_levels'), t('risk.title')],
        testRows.length ? testRows : [[t('report.no_results'), '', '', '', '', '']],
        ['26%', '11%', '10%', '10%', '31%', '12%']
    ));

    if (scope === 'college') {
        content.push({ text: t('report.by_groups'), style: 'section' });
        const groups = [...new Set(students.map(student => student.group_name || '—'))].sort();
        content.push(window.PsyPdf.table(
            [t('table.group'), t('table.students'), t('report.diagnosed'), t('res.total'), t('risk.title')],
            groups.map(group => {
                const groupStudents = students.filter(student => (student.group_name || '—') === group);
                const groupResults = results.filter(result => (result.group_name || '—') === group);
                return [group, groupStudents.length, countUniqueStudents(groupResults), groupResults.length, countRiskStudents(groupResults)];
            }),
            ['28%', '18%', '18%', '18%', '18%']
        ));
    } else {
        content.push({ text: t('report.students_list'), style: 'section' });
        content.push(window.PsyPdf.table(
            [t('table.student'), t('res.total'), t('table.date'), t('risk.title')],
            students.slice().sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).map(student => {
                const studentResults = results.filter(result => result.user_id === student.id);
                const latest = studentResults.reduce((value, result) => {
                    const timestamp = new Date(result.completed_at || 0).getTime();
                    return timestamp > value ? timestamp : value;
                }, 0);
                const reasons = [...new Set(studentResults.flatMap(result =>
                    riskInfoForResult(result).reasons.map(reason => reason.label)
                ))];
                return [
                    student.full_name,
                    studentResults.length,
                    latest ? formatDateTime(new Date(latest).toISOString()) : '—',
                    reasons.join('; ') || '—'
                ];
            }),
            ['32%', '12%', '20%', '36%']
        ));
    }

    const riskByStudent = new Map();
    results.forEach(result => {
        const risk = riskInfoForResult(result);
        if (!risk.atRisk) return;
        const current = riskByStudent.get(result.user_id) || {
            name: result.full_name,
            group: result.group_name,
            reasons: new Set()
        };
        risk.reasons.forEach(reason => current.reasons.add(reason.label));
        riskByStudent.set(result.user_id, current);
    });
    content.push({ text: t('risk.title'), style: 'section' });
    content.push(window.PsyPdf.table(
        [t('table.student'), t('table.group'), t('risk.reason')],
        riskByStudent.size
            ? [...riskByStudent.values()].map(item => [item.name, item.group || '—', [...item.reasons].join('; ')])
            : [[t('risk.empty'), '', '']],
        ['34%', '18%', '48%']
    ));
    content.push(
        { text: `${t('report.notes')}: ________________________________________________`, margin: [0, 18, 0, 8] },
        {
            text: `${t('report.psychologist')}: ____________________ / ${currentUser.fullName || ''}`,
            style: 'signature'
        }
    );

    return window.PsyPdf.baseDefinition(content, {
        title,
        landscape: true
    });
}

async function openSummaryReport(scope) {
    const groupName = document.getElementById('resultGroup')?.value || '';
    if (scope === 'group' && !groupName) {
        alert(t('results.select_group'));
        return;
    }
    try {
        const params = resultQueryParams(false);
        if (scope === 'group') params.set('groupId', groupName);
        const [studentsResponse, resultsResponse] = await Promise.all([
            fetch('/api/students', { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch(`/api/results?${params}`, { headers: { 'Authorization': `Bearer ${token}` } })
        ]);
        if (!studentsResponse.ok || !resultsResponse.ok) throw new Error(t('msg.error'));
        const allStudents = await studentsResponse.json();
        const results = await resultsResponse.json();
        const studentSearch = document.getElementById('resultSearch')?.value?.trim().toLocaleLowerCase() || '';
        const students = (Array.isArray(allStudents) ? allStudents : [])
            .filter(student => scope !== 'group' || student.group_name === groupName)
            .filter(student => !studentSearch || String(student.full_name || '').toLocaleLowerCase().includes(studentSearch));
        summaryReportData = {
            scope,
            students,
            results: Array.isArray(results) ? results : [],
            groupName
        };
        summaryReportHtml = buildSummaryReport(scope, students, Array.isArray(results) ? results : [], groupName);
        document.getElementById('summaryReportTitle').textContent = scope === 'group'
            ? `${t('report.group_title')}: ${groupName}`
            : t('report.college_title');
        document.getElementById('summaryReportBody').innerHTML = summaryReportHtml;
        new bootstrap.Modal(document.getElementById('summaryReportModal')).show();
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

function downloadOpenSummaryReport() {
    if (!summaryReportData) return;
    try {
        const { scope, students, results, groupName } = summaryReportData;
        const filename = scope === 'group'
            ? `${t('report.group_title')}-${groupName}-${new Date().toISOString().slice(0, 10)}`
            : `${t('report.college_title')}-${new Date().toISOString().slice(0, 10)}`;
        window.PsyPdf.download(
            buildSummaryPdfDefinition(scope, students, results, groupName),
            filename
        );
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
    }
}

async function downloadStudentReport(studentId) {
    try {
        const [sRes, rRes] = await Promise.all([
            fetch('/api/students', { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch('/api/results', { headers: { 'Authorization': `Bearer ${token}` } })
        ]);
        const students = await sRes.json();
        const results = await rRes.json();
        const student = (Array.isArray(students) ? students : []).find(s => s.id === studentId);
        if (!student) return;
        const userResults = (Array.isArray(results) ? results : []).filter(r => r.user_id === studentId);
        window.PsyPdf.download(
            buildStudentPdfDefinition(student, userResults),
            `${t('report.title')}-${student.full_name}-${new Date().toISOString().slice(0, 10)}`
        );
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

async function downloadResultReport(resultId) {
    try {
        const [sRes, rRes] = await Promise.all([
            fetch('/api/students', { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch('/api/results', { headers: { 'Authorization': `Bearer ${token}` } })
        ]);
        const students = await sRes.json();
        const results = await rRes.json();
        const r = (Array.isArray(results) ? results : []).find(x => x.id === resultId);
        if (!r) return;
        const student = (Array.isArray(students) ? students : []).find(s => s.id === r.user_id)
            || { full_name: r.full_name, group_name: r.group_name };
        window.PsyPdf.download(
            buildStudentPdfDefinition(student, [r]),
            `${t('report.title')}-${student.full_name}-${r.questionnaire_title}-${new Date().toISOString().slice(0, 10)}`
        );
    } catch (e) {
        alert(t('msg.error') + ': ' + e.message);
    }
}

// ========== ЭКСПОРТ РЕЗУЛЬТАТОВ В EXCEL ==========
async function exportResults() {
    try {
        const res = await fetch('/api/export/json', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const records = Array.isArray(data?.data) ? data.data : [];

        if (records.length === 0) {
            alert(t('msg.no_results_export'));
            return;
        }

        const rows = records.map(r => ({
            'ФИО': r.full_name || '',
            'Группа': r.group_name || '',
            'Тест': r.test_title || '',
            'Балл': r.score,
            'Статус': r.status || '',
            'Дата завершения': r.completed_at ? new Date(r.completed_at).toLocaleString('ru-RU') : ''
        }));

        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 28 }, { wch: 8 }, { wch: 14 }, { wch: 20 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Результаты');
        XLSX.writeFile(wb, `diagnostic-results-${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (e) {
        alert(t('msg.export_error'));
    }
}

async function loadGroupsForFilters() {
    try {
        const res = await fetch('/api/groups', { headers: { 'Authorization': `Bearer ${token}` }});
        const groupsRaw = await res.json();
        const groups = Array.isArray(groupsRaw) ? groupsRaw : (groupsRaw?.data || []);

        ['filterGroup', 'resultGroup'].forEach(selectId => {
            const select = document.getElementById(selectId);
            if (select) {
                groups.forEach(g => {
                    select.innerHTML += `<option value="${esc(g.group_name)}">${esc(g.group_name)}</option>`;
                });
            }
        });
    } catch (e) {}
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU');
}

function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU');
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}

// ===== Смена/сброс пароля =====
let pwMode = null;          // 'self' | 'student' | 'bulk'
let pwStudentId = null;
let pwBulkRole = null;

function pwShowError(msg) {
    const el = document.getElementById('pwError');
    el.textContent = msg;
    el.classList.remove('d-none');
}

function openSelfPassword() {
    pwMode = 'self';
    pwStudentId = null;
    pwBulkRole = null;
    document.getElementById('passwordForm').reset();
    document.getElementById('pwError').classList.add('d-none');
    document.getElementById('pwCurrentWrap').classList.remove('d-none');
    document.getElementById('pwCurrent').required = true;
    document.getElementById('pwModalTitle').textContent = t('pw.change_own');
    new bootstrap.Modal(document.getElementById('passwordModal')).show();
}

function openResetStudentPassword(id) {
    pwMode = 'student';
    pwStudentId = id;
    pwBulkRole = null;
    const student = adminStudentsCache.find(item => item.id === id);
    const name = student ? student.full_name : '';
    document.getElementById('passwordForm').reset();
    document.getElementById('pwError').classList.add('d-none');
    document.getElementById('pwCurrentWrap').classList.add('d-none');
    document.getElementById('pwCurrent').required = false;
    document.getElementById('pwModalTitle').textContent = t('pw.reset_student') + ': ' + name;
    new bootstrap.Modal(document.getElementById('passwordModal')).show();
}

function openBulkUserPassword(role) {
    const config = adminUserSelectionConfig(role);
    if (config.selected.size === 0) {
        alert(t('users.choose_first'));
        return;
    }
    pwMode = 'bulk';
    pwStudentId = null;
    pwBulkRole = role;
    document.getElementById('passwordForm').reset();
    document.getElementById('pwError').classList.add('d-none');
    document.getElementById('pwCurrentWrap').classList.add('d-none');
    document.getElementById('pwCurrent').required = false;
    document.getElementById('pwModalTitle').textContent =
        `${t('pw.reset_selected')} (${config.selected.size})`;
    new bootstrap.Modal(document.getElementById('passwordModal')).show();
}

document.getElementById('passwordForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    document.getElementById('pwError').classList.add('d-none');
    const newPassword = document.getElementById('pwNew').value;
    if (newPassword.length < 8) { pwShowError(t('pw.min')); return; }

    try {
        let res;
        if (pwMode === 'self') {
            res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: document.getElementById('pwCurrent').value, newPassword })
            });
        } else if (pwMode === 'student') {
            res = await fetch(`/api/students/${pwStudentId}/reset-password`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword })
            });
        } else {
            const completed = await runSelectedAdminUserAction(pwBulkRole, 'reset_password', newPassword);
            if (!completed) return;
            bootstrap.Modal.getInstance(document.getElementById('passwordModal')).hide();
            alert(t('pw.reset_selected_done'));
            return;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('msg.error'));
        bootstrap.Modal.getInstance(document.getElementById('passwordModal')).hide();
        alert(pwMode === 'self' ? t('pw.changed') : t('pw.reset_done'));
        if (pwMode === 'self') logout();
    } catch (err) {
        pwShowError(err.message);
    }
});

['resultGroup', 'resultTest', 'dateFrom', 'dateTo', 'resultLevel', 'resultRisk'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', loadResults);
});
document.getElementById('resultSearch')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') loadResults();
});
