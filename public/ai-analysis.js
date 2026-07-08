// ИИ-анализ результатов: общий UI-модуль кабинетов админа и куратора.
// Текст модели рендерится только через textContent (без innerHTML) — защита от XSS.
(function () {
    'use strict';

    const state = { enabled: false, model: null };
    let statusPromise = null;

    function authHeaders() {
        return { 'Authorization': 'Bearer ' + localStorage.getItem('token') };
    }

    function aiFmtDateTime(value) {
        return value
            ? new Date(value).toLocaleString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU')
            : '—';
    }

    function initAiStatus() {
        if (!statusPromise) {
            statusPromise = fetch('/api/ai/status', { headers: authHeaders() })
                .then(res => res.ok ? res.json() : null)
                .then(data => {
                    state.enabled = Boolean(data && data.enabled);
                    state.model = data ? data.model : null;
                    if (state.enabled) {
                        document.querySelectorAll('[data-ai-only]').forEach(el => el.classList.remove('d-none'));
                    }
                })
                .catch(() => {});
        }
        return statusPromise;
    }

    // Текст LLM → абзацы и списки. Только textContent, никакого HTML из ответа модели.
    function renderAiText(container, text) {
        const lines = String(text || '').split('\n');
        let currentList = null;
        lines.forEach(rawLine => {
            const line = rawLine.trim();
            if (!line) { currentList = null; return; }
            const listMatch = line.match(/^[-•—]\s+(.*)$/);
            if (listMatch) {
                if (!currentList) {
                    currentList = document.createElement('ul');
                    currentList.className = 'mb-2';
                    container.appendChild(currentList);
                }
                const item = document.createElement('li');
                item.textContent = listMatch[1];
                currentList.appendChild(item);
            } else {
                currentList = null;
                const paragraph = document.createElement('p');
                paragraph.className = 'mb-2';
                paragraph.textContent = line;
                container.appendChild(paragraph);
            }
        });
    }

    function makeButton(labelKey, iconClass, extraClass, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-sm ${extraClass}`;
        const icon = document.createElement('i');
        icon.className = `bi ${iconClass} me-1`;
        button.appendChild(icon);
        button.appendChild(document.createTextNode(t(labelKey)));
        button.addEventListener('click', onClick);
        return button;
    }

    function showError(container, message, scope, targetId) {
        renderAnalysisState(container, scope, targetId, null);
        const alert = document.createElement('div');
        alert.className = 'alert alert-danger py-2 mt-2 mb-0';
        alert.textContent = message;
        container.appendChild(alert);
    }

    function showSpinner(container) {
        container.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'text-muted py-2';
        const spinner = document.createElement('span');
        spinner.className = 'spinner-border spinner-border-sm me-2';
        spinner.setAttribute('role', 'status');
        wrap.appendChild(spinner);
        wrap.appendChild(document.createTextNode(t('ai.generating')));
        container.appendChild(wrap);
    }

    // Отрисовка блока: сохранённый анализ либо приглашение сгенерировать.
    function renderAnalysisState(container, scope, targetId, analysis) {
        container.replaceChildren();

        const heading = document.createElement('h6');
        heading.className = 'mt-3';
        const icon = document.createElement('i');
        icon.className = 'bi bi-stars me-1 text-primary';
        heading.appendChild(icon);
        heading.appendChild(document.createTextNode(t('ai.title')));
        container.appendChild(heading);

        if (analysis && analysis.content) {
            const textWrap = document.createElement('div');
            renderAiText(textWrap, analysis.content);
            container.appendChild(textWrap);

            const disclaimer = document.createElement('p');
            disclaimer.className = 'small text-muted fst-italic mb-1';
            disclaimer.textContent = t('ai.disclaimer');
            container.appendChild(disclaimer);

            const meta = document.createElement('p');
            meta.className = 'small text-muted mb-2';
            meta.textContent = `${t('ai.generated_at')}: ${aiFmtDateTime(analysis.created_at)}`
                + (analysis.model ? ` · ${analysis.model}` : '')
                + (analysis.created_by_name ? ` · ${analysis.created_by_name}` : '');
            container.appendChild(meta);

            container.appendChild(makeButton('ai.regenerate', 'bi-arrow-clockwise', 'btn-outline-secondary',
                () => generateInto(container, scope, targetId)));
        } else {
            const empty = document.createElement('p');
            empty.className = 'text-muted mb-2';
            empty.textContent = t('ai.empty');
            container.appendChild(empty);

            container.appendChild(makeButton('ai.analyze', 'bi-stars', 'btn-outline-primary',
                () => generateInto(container, scope, targetId)));
        }
    }

    async function generateInto(container, scope, targetId) {
        showSpinner(container);
        try {
            const res = await fetch('/api/ai/analysis', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope, targetId: String(targetId) })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                showError(container, (data && data.error) || t('msg.error'), scope, targetId);
                return;
            }
            renderAnalysisState(container, scope, targetId, data && data.analysis);
        } catch (error) {
            showError(container, t('msg.error'), scope, targetId);
        }
    }

    // Точка входа: загрузить кэшированный анализ в контейнер (если функция включена).
    async function loadAiAnalysis(scope, targetId, containerId) {
        await initAiStatus();
        if (!state.enabled) return;
        const container = document.getElementById(containerId);
        if (!container) return;
        try {
            const params = new URLSearchParams({ scope, targetId: String(targetId) });
            const res = await fetch(`/api/ai/analysis?${params}`, { headers: authHeaders() });
            const data = res.ok ? await res.json() : null;
            renderAnalysisState(container, scope, targetId, data && data.analysis);
        } catch (error) {
            renderAnalysisState(container, scope, targetId, null);
        }
    }

    // Универсальная модалка #aiAnalysisModal (заголовок — только textContent).
    function openModal(scope, targetId, title) {
        const titleEl = document.getElementById('aiAnalysisModalTitle');
        const body = document.getElementById('aiAnalysisModalBody');
        if (!titleEl || !body) return;
        titleEl.textContent = title ? `${t('ai.title')}: ${title}` : t('ai.title');
        body.replaceChildren();
        new bootstrap.Modal(document.getElementById('aiAnalysisModal')).show();
        loadAiAnalysis(scope, targetId, 'aiAnalysisModalBody');
    }

    // Показ кнопок [data-ai-only], отрисованных после загрузки страницы (строки таблиц).
    async function reveal() {
        await initAiStatus();
        if (state.enabled) {
            document.querySelectorAll('[data-ai-only]').forEach(el => el.classList.remove('d-none'));
        }
    }

    window.PsyAi = {
        initAiStatus,
        loadAiAnalysis,
        openModal,
        reveal,
        get enabled() { return state.enabled; }
    };

    initAiStatus();
})();
