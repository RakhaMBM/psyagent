(function () {
    'use strict';

    function actionTarget(event) {
        if (!(event.target instanceof Element)) return null;
        const target = event.target.closest('[data-action], [data-remove-closest], [data-click-target]');
        if (!target) return null;
        const expectedEvent = target.dataset.actionEvent || 'click';
        return expectedEvent === event.type ? target : null;
    }

    function parseArgs(target) {
        if (!target.dataset.actionArgs) return [];
        try {
            const args = JSON.parse(target.dataset.actionArgs);
            return Array.isArray(args) ? args : [];
        } catch (error) {
            console.error('Некорректные аргументы действия', error);
            return [];
        }
    }

    function dispatchAction(event) {
        const target = actionTarget(event);
        if (!target) return;

        if (target.matches('a[href="#"]')) event.preventDefault();

        const clickTarget = target.dataset.clickTarget;
        if (clickTarget) {
            document.querySelector(clickTarget)?.click();
        }

        const removeSelector = target.dataset.removeClosest;
        if (removeSelector) {
            target.closest(removeSelector)?.remove();
        }

        const actionName = target.dataset.action;
        if (!actionName) return;
        if (!/^[A-Za-z_$][\w$]*$/.test(actionName)) {
            console.error(`Недопустимое действие: ${actionName}`);
            return;
        }

        const action = window[actionName];
        if (typeof action !== 'function') {
            console.error(`Действие не найдено: ${actionName}`);
            return;
        }

        const args = parseArgs(target);
        if (target.dataset.actionPass === 'event') args.push(event);
        if (target.dataset.actionPass === 'element') args.push(target);
        if (target.dataset.actionPass === 'value') args.push(target.value);

        try {
            const result = action(...args);
            if (result && typeof result.catch === 'function') {
                result.catch(error => console.error(`Ошибка действия ${actionName}`, error));
            }
        } catch (error) {
            console.error(`Ошибка действия ${actionName}`, error);
        }
    }

    document.addEventListener('click', dispatchAction);
    document.addEventListener('change', dispatchAction);
    document.addEventListener('input', dispatchAction);
})();
