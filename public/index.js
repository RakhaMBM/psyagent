// Показать/скрыть пароль
document.getElementById('togglePassword').addEventListener('click', function() {
    const pwd = document.getElementById('password');
    const icon = this.querySelector('i');
    if (pwd.type === 'password') {
        pwd.type = 'text';
        icon.classList.replace('bi-eye', 'bi-eye-slash');
    } else {
        pwd.type = 'password';
        icon.classList.replace('bi-eye-slash', 'bi-eye');
    }
});

// Обработка входа
document.getElementById('loginForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const btn = document.getElementById('loginBtn');
    const spinner = btn.querySelector('.spinner-border');
    const btnText = btn.querySelector('.btn-text');
    const errorMsg = document.getElementById('errorMsg');

    // Показываем загрузку
    spinner.classList.remove('d-none');
    btnText.textContent = t('login.logging_in');
    btn.disabled = true;
    errorMsg.classList.add('d-none');

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value,
                password: document.getElementById('password').value,
                college: document.getElementById('college').value.trim()
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || t('login.error'));
        }

        // Сохраняем токен
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));

        // Перенаправление по роли
        redirectByRole(data.user.role);

    } catch (error) {
        errorMsg.textContent = error.message;
        errorMsg.classList.remove('d-none');

        // Сбрасываем кнопку
        spinner.classList.add('d-none');
        btnText.textContent = t('login.submit');
        btn.disabled = false;
    }
});

// Проверяем авторизацию при загрузке
window.addEventListener('load', async () => {
    const token = localStorage.getItem('token');
    const user = localStorage.getItem('user');

    if (token && user) {
        try {
            const response = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) throw new Error('expired');
            const actual = await response.json();
            const cached = JSON.parse(user);
            const refreshed = {
                ...cached,
                id: actual.id,
                username: actual.username,
                fullName: actual.full_name,
                role: actual.role,
                groupName: actual.group_name
            };
            localStorage.setItem('user', JSON.stringify(refreshed));
            redirectByRole(actual.role);
        } catch (_) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        }
    }
});

function redirectByRole(role) {
    if (role === 'super_admin') window.location.href = '/platform';
    else if (role === 'admin') window.location.href = '/admin';
    else if (role === 'curator') window.location.href = '/curator';
    else window.location.href = '/student';
}
