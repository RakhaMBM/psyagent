(function () {
    'use strict';

    function safeFilename(value) {
        return String(value || 'report')
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 120) || 'report';
    }

    function table(headers, rows, widths = null) {
        return {
            table: {
                headerRows: 1,
                widths: widths || headers.map(() => '*'),
                body: [
                    headers.map(text => ({ text: String(text), style: 'tableHeader' })),
                    ...rows.map(row => row.map(value => ({
                        text: value == null || value === '' ? '—' : String(value),
                        style: 'tableCell'
                    })))
                ]
            },
            layout: {
                fillColor: rowIndex => rowIndex === 0 ? '#eef2f7' : null,
                hLineColor: '#aeb7c2',
                vLineColor: '#aeb7c2'
            },
            margin: [0, 4, 0, 10]
        };
    }

    function keyValueTable(rows, widths = ['35%', '65%']) {
        return {
            table: {
                widths,
                body: rows.map(([key, value]) => [
                    { text: String(key), bold: true, fillColor: '#eef2f7', margin: [2, 3, 2, 3] },
                    { text: value == null || value === '' ? '—' : String(value), margin: [2, 3, 2, 3] }
                ])
            },
            layout: {
                hLineColor: '#aeb7c2',
                vLineColor: '#aeb7c2'
            },
            margin: [0, 4, 0, 10]
        };
    }

    function baseDefinition(content, options = {}) {
        return {
            pageSize: 'A4',
            pageOrientation: options.landscape ? 'landscape' : 'portrait',
            pageMargins: options.landscape ? [30, 26, 30, 32] : [36, 40, 36, 44],
            info: { title: options.title || 'Psyagent' },
            content,
            defaultStyle: { font: 'Roboto', fontSize: 9, color: '#172033', lineHeight: 1.2 },
            styles: {
                title: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 0, 0, 4] },
                date: { fontSize: 9, color: '#667085', alignment: 'center', margin: [0, 0, 0, 14] },
                section: { fontSize: 12, bold: true, color: '#1f3c88', margin: [0, 12, 0, 5] },
                subsection: { fontSize: 10, bold: true, margin: [0, 8, 0, 3] },
                meta: { fontSize: 8, color: '#667085', margin: [0, 1, 0, 4] },
                warning: { fontSize: 9, bold: true, color: '#b42318', margin: [0, 3, 0, 3] },
                tableHeader: { fontSize: 8, bold: true, color: '#172033', margin: [2, 3, 2, 3] },
                tableCell: { fontSize: 8, margin: [2, 3, 2, 3] },
                signature: { margin: [0, 8, 0, 0] }
            },
            footer: (currentPage, pageCount) => ({
                text: `${currentPage} / ${pageCount}`,
                alignment: 'center',
                color: '#98a2b3',
                fontSize: 8,
                margin: [0, 12, 0, 0]
            })
        };
    }

    function download(definition, filename) {
        if (!window.pdfMake || typeof window.pdfMake.createPdf !== 'function') {
            throw new Error(typeof t === 'function' ? t('report.pdf_unavailable') : 'PDF недоступен');
        }
        window.pdfMake.createPdf(definition).download(`${safeFilename(filename)}.pdf`);
    }

    function fmtDate(d) {
        return d ? new Date(d).toLocaleDateString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU') : '—';
    }

    function fmtDateTime(d) {
        return d ? new Date(d).toLocaleString(getLang() === 'kz' ? 'kk-KZ' : 'ru-RU') : '—';
    }

    function scoreResult(result) {
        const methodology = window.methodologyForResult ? window.methodologyForResult(result) : null;
        return methodology && window.scoreMethodology
            ? window.scoreMethodology(methodology, result.answers || {})
            : null;
    }

    // Общее PDF-заключение по студенту (кабинеты админа и куратора).
    // opts.extraInfoRows — дополнительные строки шапки (например, семья и быт);
    // opts.psychologistName — имя в строке подписи.
    function buildStudentReport(student, results, opts = {}) {
        const content = [
            { text: t('report.title'), style: 'title' },
            { text: fmtDate(new Date()), style: 'date' },
            keyValueTable([
                [t('table.fio'), student.full_name || '—'],
                [t('table.group'), student.group_name || '—'],
                [
                    t('table.birth_date'),
                    `${student.birth_date ? fmtDate(student.birth_date) : '—'}${student.age != null ? ` (${student.age} ${t('unit.years')})` : ''}`
                ],
                [t('field.school'), student.school || '—'],
                ...(opts.extraInfoRows || [])
            ]),
            { text: t('report.results'), style: 'section' }
        ];

        const list = Array.isArray(results) ? results : [];
        const byTest = new Map();
        list.forEach(result => {
            const title = result.questionnaire_title || '—';
            if (!byTest.has(title)) byTest.set(title, []);
            byTest.get(title).push(result);
        });

        if (!list.length) content.push({ text: t('report.no_results'), color: '#667085' });

        for (const [title, group] of byTest.entries()) {
            group.sort((a, b) => new Date(a.completed_at || 0) - new Date(b.completed_at || 0));
            content.push({ text: title, style: 'subsection' });
            if (group.length > 1) {
                const dynamics = group.map(result => {
                    const scored = scoreResult(result);
                    return scored && scored.primary ? scored.primary.raw : result.score;
                });
                content.push({ text: `${t('report.dynamics')}: ${dynamics.join(' → ')}`, style: 'meta' });
            }
            for (const result of group) {
                content.push({ text: `${t('table.date')}: ${fmtDateTime(result.completed_at)}`, style: 'meta' });
                const scored = scoreResult(result);
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
                content.push(table(
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
                text: `${t('report.psychologist')}: ____________________${opts.psychologistName ? ` / ${opts.psychologistName}` : ''}`,
                style: 'signature'
            }
        );
        return baseDefinition(content, { title: t('report.title') });
    }

    window.PsyPdf = {
        safeFilename, table, keyValueTable, baseDefinition, download,
        fmtDate, fmtDateTime, buildStudentReport
    };
})();
