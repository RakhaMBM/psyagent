const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

// Доступ только для супер-админа
if (!token || !user || user.role !== 'super_admin') {
    window.location.href = '/';
} else {
    document.getElementById('whoami').textContent = user.fullName || user.username;
}

const authHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
let platformUsersCache = [];

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadTenants() {
    try {
        const res = await fetch('/api/platform/tenants', { headers: authHeaders });
        if (res.status === 401 || res.status === 403) return logout();
        const list = await res.json();
        // Заполняем выпадающий список колледжей для панели поддержки
        const sel = document.getElementById('supportTenant');
        const prev = sel.value;
        sel.innerHTML = '<option value="">— выберите колледж —</option>' +
            (Array.isArray(list) ? list.map(t => `<option value="${t.id}">${esc(t.name)} (${esc(t.code)})</option>`).join('') : '');
        if (prev) sel.value = prev;

        const tbody = document.getElementById('tenantsTable');
        if (!Array.isArray(list) || list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Нет колледжей</td></tr>';
            return;
        }
        tbody.innerHTML = list.map(t => `
            <tr>
                <td><code>${esc(t.code)}</code></td>
                <td>${esc(t.name)}</td>
                <td class="small text-muted">${esc(t.db_name)}</td>
                <td class="text-center">${t.student_count == null ? '—' : t.student_count}</td>
                <td class="text-center">
                    ${t.is_active
                        ? '<span class="badge bg-success">активен</span>'
                        : '<span class="badge bg-secondary">отключён</span>'}
                </td>
                <td class="text-end">
                    ${t.code === 'default' ? '<span class="text-muted small">—</span>' :
                        (t.is_active
                            ? `<button class="btn btn-sm btn-outline-secondary" data-action="toggleTenant" data-action-args='[${t.id},false]'><i class="bi bi-pause-circle me-1"></i>Отключить</button>`
                            : `<button class="btn btn-sm btn-outline-success" data-action="toggleTenant" data-action-args='[${t.id},true]'><i class="bi bi-play-circle me-1"></i>Включить</button>`)}
                </td>
            </tr>`).join('');
    } catch (e) {
        document.getElementById('tenantsTable').innerHTML =
            '<tr><td colspan="6" class="text-center text-danger py-4">Ошибка загрузки</td></tr>';
    }
}

document.getElementById('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('createBtn');
    const spinner = btn.querySelector('.spinner-border');
    const msg = document.getElementById('formMsg');
    spinner.classList.remove('d-none');
    btn.disabled = true;
    msg.innerHTML = '';
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
        msg.innerHTML = `<div class="alert alert-success py-2">Колледж <b>${esc(data.code)}</b> создан (БД: ${esc(data.db_name)})</div>`;
        e.target.reset();
        loadTenants();
    } catch (err) {
        msg.innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`;
    } finally {
        spinner.classList.add('d-none');
        btn.disabled = false;
    }
});

const roleLabel = (r) => ({ admin: 'Психолог', curator: 'Куратор', student: 'Студент' }[r] || r);

async function loadTenantUsers() {
    const tenantId = document.getElementById('supportTenant').value;
    const tbody = document.getElementById('supportUsers');
    document.getElementById('supportMsg').innerHTML = '';
    if (!tenantId) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Выберите колледж</td></tr>';
        return;
    }
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Загрузка…</td></tr>';
    try {
        const search = encodeURIComponent(document.getElementById('supportSearch').value.trim());
        const res = await fetch(`/api/platform/tenants/${tenantId}/users?search=${search}`, { headers: authHeaders });
        if (res.status === 401 || res.status === 403) return logout();
        const users = await res.json();
        platformUsersCache = Array.isArray(users) ? users : [];
        if (!Array.isArray(users) || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Пользователи не найдены</td></tr>';
            return;
        }
        tbody.innerHTML = users.map(u => `
            <tr>
                <td>${esc(u.full_name)}${u.is_active ? '' : ' <span class="badge bg-secondary">отключён</span>'}</td>
                <td><code>${esc(u.username)}</code></td>
                <td>${esc(roleLabel(u.role))}</td>
                <td class="small text-muted">${esc(u.group_name || '—')}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-danger" data-action="resetUserPassword" data-action-args='[${Number(tenantId)},${u.id}]'>
                        <i class="bi bi-key me-1"></i>Сбросить пароль
                    </button>
                </td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-3">Ошибка загрузки</td></tr>';
    }
}

async function resetUserPassword(tenantId, userId) {
    const selectedUser = platformUsersCache.find(item => item.id === userId);
    const username = selectedUser ? selectedUser.username : '';
    const newPassword = prompt(`Новый пароль для «${username}» (минимум 8 символов):`);
    if (newPassword == null) return;
    if (newPassword.length < 8) {
        alert('Пароль должен быть не короче 8 символов');
        return;
    }
    try {
        const res = await fetch('/api/platform/reset-password', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ tenantId, userId, newPassword })
        });
        const data = await res.json();
        const msg = document.getElementById('supportMsg');
        if (!res.ok) throw new Error(data.error || 'Ошибка');
        msg.innerHTML = `<div class="alert alert-success py-2">${esc(data.message)}</div>`;
    } catch (err) {
        document.getElementById('supportMsg').innerHTML = `<div class="alert alert-danger py-2">${esc(err.message)}</div>`;
    }
}

document.getElementById('supportTenant').addEventListener('change', loadTenantUsers);

async function toggleTenant(id, makeActive) {
    if (!confirm(makeActive ? 'Включить колледж?' : 'Отключить колледж? Его пользователи не смогут войти.')) return;
    try {
        const res = await fetch('/api/platform/tenants/' + id, {
            method: 'PATCH',
            headers: authHeaders,
            body: JSON.stringify({ is_active: makeActive })
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || 'Ошибка');
        }
        loadTenants();
    } catch (err) {
        alert(err.message);
    }
}

loadTenants();
