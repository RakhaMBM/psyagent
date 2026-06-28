const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user || user.role !== 'super_admin') {
    window.location.href = '/';
} else {
    document.getElementById('whoami').textContent = user.fullName || user.username;
}

const authHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
let tenantsCache = [];
let platformUsersCache = [];
const selectedPlatformUsers = new Set();
let editingPlatformUserId = null;

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showSupportMessage(message, type = 'success') {
    document.getElementById('supportMsg').innerHTML =
        message ? `<div class="alert alert-${type} py-2">${esc(message)}</div>` : '';
}

function clearPlatformUsers(message = 'Выберите колледж') {
    platformUsersCache = [];
    selectedPlatformUsers.clear();
    document.getElementById('supportUsers').innerHTML =
        `<tr><td colspan="7" class="text-center text-muted py-3">${esc(message)}</td></tr>`;
    updatePlatformSelection();
}

async function loadTenants() {
    try {
        const res = await fetch('/api/platform/tenants', { headers: authHeaders });
        if (res.status === 401 || res.status === 403) return logout();
        const list = await res.json();
        if (!res.ok) throw new Error(list.error || 'Ошибка загрузки колледжей');
        tenantsCache = Array.isArray(list) ? list : [];

        const select = document.getElementById('supportTenant');
        const previousTenantId = select.value;
        select.innerHTML = '<option value="">— выберите колледж —</option>' +
            tenantsCache.map(tenant =>
                `<option value="${tenant.id}">${esc(tenant.name)} (${esc(tenant.code)})${tenant.is_active ? '' : ' — отключён'}</option>`
            ).join('');
        if (tenantsCache.some(tenant => String(tenant.id) === previousTenantId)) {
            select.value = previousTenantId;
        }
        document.getElementById('addPlatformUserBtn').disabled = !select.value;

        const tbody = document.getElementById('tenantsTable');
        if (tenantsCache.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Нет колледжей</td></tr>';
            return;
        }
        tbody.innerHTML = tenantsCache.map(tenant => `
            <tr>
                <td><code>${esc(tenant.code)}</code></td>
                <td>${esc(tenant.name)}</td>
                <td class="small text-muted">${esc(tenant.db_name)}</td>
                <td class="text-center">${tenant.student_count == null ? '—' : tenant.student_count}</td>
                <td class="text-center">
                    ${tenant.is_active
                        ? '<span class="badge bg-success">активен</span>'
                        : '<span class="badge bg-secondary">отключён</span>'}
                </td>
                <td class="text-end">
                    ${tenant.code === 'default'
                        ? '<span class="text-muted small">защищён</span>'
                        : `<div class="btn-group btn-group-sm">
                            <button class="btn ${tenant.is_active ? 'btn-outline-warning' : 'btn-outline-success'}"
                                    data-action="toggleTenant" data-action-args='[${tenant.id},${tenant.is_active ? 'false' : 'true'}]'>
                                <i class="bi ${tenant.is_active ? 'bi-pause-circle' : 'bi-play-circle'} me-1"></i>
                                ${tenant.is_active ? 'Отключить' : 'Включить'}
                            </button>
                            <button class="btn btn-outline-danger" data-action="deleteTenant"
                                    data-action-args='[${tenant.id},"${esc(tenant.code)}"]'>
                                <i class="bi bi-trash me-1"></i>Удалить
                            </button>
                        </div>`}
                </td>
            </tr>`).join('');
    } catch (error) {
        document.getElementById('tenantsTable').innerHTML =
            `<tr><td colspan="6" class="text-center text-danger py-4">${esc(error.message)}</td></tr>`;
    }
}

document.getElementById('createForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('createBtn');
    const spinner = button.querySelector('.spinner-border');
    const message = document.getElementById('formMsg');
    spinner.classList.remove('d-none');
    button.disabled = true;
    message.innerHTML = '';
    try {
        const res = await fetch('/api/platform/tenants', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
                code: document.getElementById('code').value.trim(),
                name: document.getElementById('name').value.trim(),
                adminFullName: document.getElementById('adminFullName').value.trim(),
                adminUsername: document.getElementById('adminUsername').value.trim(),
                adminPassword: document.getElementById('adminPassword').value
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Ошибка создания');
        message.innerHTML = `<div class="alert alert-success py-2">Колледж <b>${esc(data.code)}</b> создан (БД: ${esc(data.db_name)})</div>`;
        event.target.reset();
        await loadTenants();
    } catch (error) {
        message.innerHTML = `<div class="alert alert-danger py-2">${esc(error.message)}</div>`;
    } finally {
        spinner.classList.add('d-none');
        button.disabled = false;
    }
});

const roleLabel = role => ({ admin: 'Психолог', curator: 'Куратор', student: 'Студент' }[role] || role);

function updatePlatformSelection() {
    const count = selectedPlatformUsers.size;
    document.getElementById('platformSelectedCount').textContent = count;
    document.getElementById('editPlatformUserBtn').disabled = count !== 1;
    ['resetPlatformUsersBtn', 'activatePlatformUsersBtn', 'deactivatePlatformUsersBtn'].forEach(id => {
        document.getElementById(id).disabled = count === 0;
    });
    const selectAll = document.getElementById('selectAllPlatformUsers');
    selectAll.checked = platformUsersCache.length > 0 && count === platformUsersCache.length;
    selectAll.indeterminate = count > 0 && count < platformUsersCache.length;
}

function togglePlatformUser(userId, element) {
    if (element.checked) selectedPlatformUsers.add(Number(userId));
    else selectedPlatformUsers.delete(Number(userId));
    updatePlatformSelection();
}

function toggleAllPlatformUsers(element) {
    selectedPlatformUsers.clear();
    if (element.checked) {
        platformUsersCache.forEach(item => selectedPlatformUsers.add(Number(item.id)));
    }
    document.querySelectorAll('[data-platform-user-select]').forEach(checkbox => {
        checkbox.checked = element.checked;
    });
    updatePlatformSelection();
}

async function loadTenantUsers() {
    const tenantId = document.getElementById('supportTenant').value;
    const tbody = document.getElementById('supportUsers');
    showSupportMessage('');
    selectedPlatformUsers.clear();
    updatePlatformSelection();
    document.getElementById('addPlatformUserBtn').disabled = !tenantId;
    if (!tenantId) {
        clearPlatformUsers();
        return;
    }

    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">Загрузка…</td></tr>';
    try {
        const params = new URLSearchParams();
        const search = document.getElementById('supportSearch').value.trim();
        const role = document.getElementById('supportRole').value;
        const status = document.getElementById('supportStatus').value;
        if (search) params.set('search', search);
        if (role) params.set('role', role);
        if (status) params.set('status', status);

        const res = await fetch(`/api/platform/tenants/${tenantId}/users?${params}`, { headers: authHeaders });
        if (res.status === 401 || res.status === 403) return logout();
        const users = await res.json();
        if (!res.ok) throw new Error(users.error || 'Ошибка загрузки пользователей');
        platformUsersCache = Array.isArray(users) ? users : [];
        if (platformUsersCache.length === 0) {
            clearPlatformUsers('Пользователи не найдены');
            return;
        }

        tbody.innerHTML = platformUsersCache.map(item => `
            <tr>
                <td class="selection-column">
                    <input class="form-check-input" type="checkbox" data-platform-user-select
                           data-action="togglePlatformUser" data-action-args='[${item.id}]'
                           data-action-event="change" data-action-pass="element"
                           aria-label="Выбрать ${esc(item.full_name)}">
                </td>
                <td class="fw-semibold">${esc(item.full_name)}</td>
                <td><code>${esc(item.username)}</code></td>
                <td>${esc(roleLabel(item.role))}</td>
                <td>${esc(item.group_name || '—')}</td>
                <td class="small">
                    ${item.email ? `<div>${esc(item.email)}</div>` : ''}
                    ${item.phone ? `<div class="text-muted">${esc(item.phone)}</div>` : ''}
                    ${!item.email && !item.phone ? '<span class="text-muted">—</span>' : ''}
                </td>
                <td class="text-center">
                    ${item.is_active
                        ? '<span class="badge bg-success">активен</span>'
                        : '<span class="badge bg-secondary">отключён</span>'}
                </td>
            </tr>`).join('');
        updatePlatformSelection();
    } catch (error) {
        platformUsersCache = [];
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-3">${esc(error.message)}</td></tr>`;
        updatePlatformSelection();
    }
}

async function runPlatformBulkRequest(action, newPassword = null) {
    const tenantId = document.getElementById('supportTenant').value;
    if (!tenantId || selectedPlatformUsers.size === 0) {
        showSupportMessage('Сначала выберите колледж и пользователей', 'warning');
        return false;
    }
    const res = await fetch(`/api/platform/tenants/${tenantId}/users/bulk`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
            userIds: [...selectedPlatformUsers],
            action,
            newPassword
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка операции');
    await loadTenantUsers();
    showSupportMessage(data.message);
    return true;
}

async function runSelectedPlatformAction(action) {
    if (selectedPlatformUsers.size === 0) {
        showSupportMessage('Сначала выберите пользователей', 'warning');
        return;
    }
    const question = action === 'activate'
        ? `Включить выбранных пользователей (${selectedPlatformUsers.size})?`
        : `Отключить выбранных пользователей (${selectedPlatformUsers.size})? Их активные сессии будут завершены.`;
    if (!confirm(question)) return;
    try {
        await runPlatformBulkRequest(action);
    } catch (error) {
        showSupportMessage(error.message, 'danger');
    }
}

function updatePlatformUserRoleFields() {
    const role = document.getElementById('platformUserRole').value;
    const form = document.getElementById('platformUserForm');
    const birthWrap = document.getElementById('platformBirthDateWrap');
    const groupWrap = document.getElementById('platformGroupWrap');
    birthWrap.classList.toggle('d-none', role !== 'student');
    groupWrap.classList.toggle('d-none', role === 'admin');
    form.elements.birth_date.required = role === 'student';
    form.elements.group_name.required = role === 'curator';
}

function openPlatformUserModal(userId = null) {
    const tenantId = document.getElementById('supportTenant').value;
    if (!tenantId) {
        showSupportMessage('Сначала выберите колледж', 'warning');
        return;
    }
    editingPlatformUserId = userId == null ? null : Number(userId);
    const form = document.getElementById('platformUserForm');
    form.reset();
    document.getElementById('platformUserError').classList.add('d-none');
    const role = document.getElementById('platformUserRole');
    const passwordWrap = document.getElementById('platformUserPasswordWrap');
    const password = form.elements.password;
    const roleHint = document.getElementById('platformRoleLockedHint');

    if (editingPlatformUserId == null) {
        document.getElementById('platformUserModalTitle').textContent = 'Добавить пользователя';
        role.disabled = false;
        role.value = 'student';
        roleHint.classList.add('d-none');
        passwordWrap.classList.remove('d-none');
        password.required = true;
    } else {
        const selected = platformUsersCache.find(item => Number(item.id) === editingPlatformUserId);
        if (!selected) {
            showSupportMessage('Пользователь не найден в текущей выборке', 'warning');
            return;
        }
        document.getElementById('platformUserModalTitle').textContent = 'Редактировать пользователя';
        form.elements.full_name.value = selected.full_name || '';
        form.elements.username.value = selected.username || '';
        role.value = selected.role;
        role.disabled = true;
        roleHint.classList.remove('d-none');
        passwordWrap.classList.add('d-none');
        password.required = false;
        form.elements.birth_date.value = selected.birth_date
            ? String(selected.birth_date).slice(0, 10)
            : '';
        form.elements.group_name.value = selected.group_name || '';
        form.elements.email.value = selected.email || '';
        form.elements.phone.value = selected.phone || '';
    }
    updatePlatformUserRoleFields();
    new bootstrap.Modal(document.getElementById('platformUserModal')).show();
}

function editSelectedPlatformUser() {
    if (selectedPlatformUsers.size !== 1) return;
    openPlatformUserModal([...selectedPlatformUsers][0]);
}

document.getElementById('platformUserForm').addEventListener('submit', async event => {
    event.preventDefault();
    const tenantId = document.getElementById('supportTenant').value;
    const errorBox = document.getElementById('platformUserError');
    errorBox.classList.add('d-none');
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (editingPlatformUserId == null) {
        data.role = document.getElementById('platformUserRole').value;
    }

    try {
        const url = editingPlatformUserId == null
            ? `/api/platform/tenants/${tenantId}/users`
            : `/api/platform/tenants/${tenantId}/users/${editingPlatformUserId}`;
        const res = await fetch(url, {
            method: editingPlatformUserId == null ? 'POST' : 'PUT',
            headers: authHeaders,
            body: JSON.stringify(data)
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.error || 'Ошибка сохранения');
        bootstrap.Modal.getInstance(document.getElementById('platformUserModal')).hide();
        await loadTenantUsers();
        await loadTenants();
        showSupportMessage(result.message);
    } catch (error) {
        errorBox.textContent = error.message;
        errorBox.classList.remove('d-none');
    }
});

function openPlatformPasswordModal() {
    if (selectedPlatformUsers.size === 0) {
        showSupportMessage('Сначала выберите пользователей', 'warning');
        return;
    }
    document.getElementById('platformPasswordForm').reset();
    document.getElementById('platformPasswordError').classList.add('d-none');
    document.getElementById('platformPasswordCount').textContent = selectedPlatformUsers.size;
    new bootstrap.Modal(document.getElementById('platformPasswordModal')).show();
}

document.getElementById('platformPasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.getElementById('platformPasswordError');
    errorBox.classList.add('d-none');
    const newPassword = document.getElementById('platformNewPassword').value;
    if (newPassword.length < 8) {
        errorBox.textContent = 'Пароль должен быть не короче 8 символов';
        errorBox.classList.remove('d-none');
        return;
    }
    try {
        await runPlatformBulkRequest('reset_password', newPassword);
        bootstrap.Modal.getInstance(document.getElementById('platformPasswordModal')).hide();
    } catch (error) {
        errorBox.textContent = error.message;
        errorBox.classList.remove('d-none');
    }
});

document.getElementById('supportTenant').addEventListener('change', loadTenantUsers);
document.getElementById('supportRole').addEventListener('change', loadTenantUsers);
document.getElementById('supportStatus').addEventListener('change', loadTenantUsers);
document.getElementById('supportSearch').addEventListener('keydown', event => {
    if (event.key === 'Enter') loadTenantUsers();
});
document.getElementById('platformUserRole').addEventListener('change', updatePlatformUserRoleFields);

async function toggleTenant(id, makeActive) {
    if (!confirm(makeActive ? 'Включить колледж?' : 'Отключить колледж? Его пользователи не смогут войти.')) return;
    try {
        const res = await fetch('/api/platform/tenants/' + id, {
            method: 'PATCH',
            headers: authHeaders,
            body: JSON.stringify({ is_active: makeActive })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Ошибка');
        await loadTenants();
    } catch (error) {
        alert(error.message);
    }
}

async function deleteTenant(id, code) {
    const confirmation = prompt(
        `Колледж и вся его база данных будут удалены безвозвратно.\n\nДля подтверждения введите код колледжа: ${code}`
    );
    if (confirmation == null) return;
    if (confirmation.trim() !== code) {
        alert('Код не совпадает. Удаление отменено.');
        return;
    }
    if (!confirm(`Окончательно удалить колледж «${code}» и все его данные?`)) return;

    try {
        const res = await fetch('/api/platform/tenants/' + id, {
            method: 'DELETE',
            headers: authHeaders,
            body: JSON.stringify({ confirmCode: confirmation.trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Ошибка удаления');
        if (document.getElementById('supportTenant').value === String(id)) {
            document.getElementById('supportTenant').value = '';
            clearPlatformUsers();
        }
        alert(data.message);
        await loadTenants();
    } catch (error) {
        alert(error.message);
    }
}

loadTenants();
