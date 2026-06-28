const esc = window.escapeHtml;
const pathParts = window.location.pathname.split('/').filter(Boolean);
const collegeCode = decodeURIComponent(pathParts[1] || '');
const accessToken = decodeURIComponent(pathParts[2] || '');
let surveyData = null;

window.onLangChange = function () {
    if (surveyData) renderSurvey(surveyData);
};

function showSurveyError(message) {
    document.getElementById('surveyLoading').classList.add('d-none');
    document.getElementById('anonymousSurveyForm').classList.add('d-none');
    const box = document.getElementById('surveyError');
    box.textContent = message;
    box.classList.remove('d-none');
}

function responseMarker() {
    return `psyagent-anonymous-submitted:${collegeCode}:${accessToken}`;
}

function updateConditionalQuestions() {
    if (!surveyData) return;
    for (const question of surveyData.survey.questions) {
        if (!question.showWhen) continue;
        const selected = document.querySelector(
            `input[name="${question.showWhen.questionId}"]:checked`
        )?.value;
        const visible = selected != null && selected !== question.showWhen.notEquals;
        const card = document.querySelector(`[data-question-id="${question.id}"]`);
        if (!card) continue;
        card.classList.toggle('d-none', !visible);
        card.querySelectorAll('input').forEach(input => {
            input.disabled = !visible;
            input.required = visible && question.required !== false;
            if (!visible) input.checked = false;
        });
    }
}

function renderSurvey(data) {
    surveyData = data;
    document.getElementById('surveyTitle').textContent = data.survey.title;
    document.getElementById('surveyInstruction').textContent = data.survey.instruction;
    document.getElementById('surveyGroup').textContent =
        data.campaign.target_group || data.survey.ageRange || t('anonymous.all_groups');

    document.getElementById('anonymousQuestions').innerHTML = data.survey.questions.map((question, index) => `
        <section class="card border-0 shadow-sm rounded-4 mb-3 anonymous-question" data-question-id="${esc(question.id)}">
            <div class="card-body p-4">
                <h2 class="h6 mb-3">${index + 1}. ${esc(question.text)}${question.showWhen ? ` <span class="text-muted fw-normal">(${t('anonymous.optional')})</span>` : ''}</h2>
                <div class="d-grid gap-2">
                    ${question.options.map((option, optionIndex) => `
                        <label class="anonymous-option border rounded-3 p-3" for="${esc(question.id)}-${optionIndex}">
                            <input class="form-check-input me-2" type="radio"
                                   name="${esc(question.id)}" id="${esc(question.id)}-${optionIndex}"
                                   value="${esc(option)}" ${question.required === false ? '' : 'required'}>
                            <span>${esc(option)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        </section>
    `).join('');

    document.getElementById('anonymousQuestions').querySelectorAll('input[type="radio"]')
        .forEach(input => input.addEventListener('change', updateConditionalQuestions));
    updateConditionalQuestions();

    document.getElementById('surveyLoading').classList.add('d-none');
    document.getElementById('anonymousSurveyForm').classList.remove('d-none');
}

async function loadAnonymousSurvey() {
    if (!collegeCode || !accessToken) {
        showSurveyError(t('anonymous.invalid_link'));
        return;
    }
    if (localStorage.getItem(responseMarker()) === '1') {
        document.getElementById('surveyLoading').classList.add('d-none');
        document.getElementById('surveyDone').classList.remove('d-none');
        return;
    }
    try {
        const response = await fetch(
            `/api/anonymous-surveys/${encodeURIComponent(collegeCode)}/${encodeURIComponent(accessToken)}`
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('anonymous.load_error'));
        renderSurvey(data);
    } catch (error) {
        showSurveyError(error.message);
    }
}

document.getElementById('anonymousSurveyForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    updateConditionalQuestions();
    if (!this.reportValidity()) return;

    const answers = {};
    new FormData(this).forEach((value, key) => {
        answers[key] = value;
    });

    const button = document.getElementById('anonymousSubmit');
    button.disabled = true;
    button.querySelector('.spinner-border').classList.remove('d-none');
    try {
        const response = await fetch(
            `/api/anonymous-surveys/${encodeURIComponent(collegeCode)}/${encodeURIComponent(accessToken)}/responses`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answers })
            }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('anonymous.submit_error'));
        localStorage.setItem(responseMarker(), '1');
        this.classList.add('d-none');
        document.getElementById('surveyDone').classList.remove('d-none');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
        alert(`${t('msg.error')}: ${error.message}`);
        button.disabled = false;
        button.querySelector('.spinner-border').classList.add('d-none');
    }
});

loadAnonymousSurvey();
