/**
 * Renders the "already recorded" table each page carries.
 *
 * Without it the only record of a past run is a result CSV someone had to
 * download and keep, and there is no way to answer "did this already go
 * through?" from the portal itself.
 */
function renderHistory({ endpoint, columns, emptyText, countLabel }) {
    const section = document.getElementById('history');
    const summary = document.getElementById('historySummary');
    const table = document.getElementById('historyTable');
    if (!section) return () => {};

    async function load() {
        let data;
        try {
            const res = await fetch(endpoint);
            if (res.status === 401) return;
            data = await res.json();
        } catch {
            return;
        }

        if (!data.total) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        summary.textContent = data.total === data.rows.length
            ? `${data.total} ${countLabel}`
            : `${data.total} ${countLabel} — showing the ${data.rows.length} most recent`;

        table.textContent = '';

        const head = document.createElement('tr');
        for (const column of columns) {
            const th = document.createElement('th');
            th.textContent = column.label;
            head.appendChild(th);
        }
        table.appendChild(head);

        for (const row of data.rows) {
            const tr = document.createElement('tr');
            for (const column of columns) {
                const td = document.createElement('td');
                td.textContent = column.value(row);
                tr.appendChild(td);
            }
            table.appendChild(tr);
        }
    }

    load();
    return load;
}

function whenText(value) {
    if (!value) return '';
    const at = new Date(value);
    return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
        ' ' + at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
