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

    window.PsyPdf = { safeFilename, table, keyValueTable, baseDefinition, download };
})();
