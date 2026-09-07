/**
 * The line at the top of each page saying where the portal got to last time.
 *
 * Uploads come every few months, not every month, so the first thing anyone
 * needs on returning is which months are already done — otherwise the only way
 * to tell is to upload and read the duplicates.
 */
function showLastRun(describe) {
    const el = document.getElementById('lastRun');
    if (!el) return () => {};

    async function load() {
        let data;
        try {
            const res = await fetch('/api/last-run');
            if (!res.ok) return;
            data = await res.json();
        } catch {
            return;
        }

        const text = describe(data);
        if (!text) {
            el.style.display = 'none';
            return;
        }

        el.style.display = 'block';
        el.textContent = text;
    }

    load();
    return load;
}

/** "12 September" — the month matters more than the exact day here. */
function onDate(value) {
    if (!value) return '';
    return new Date(value).toLocaleDateString(undefined, {
        day: 'numeric', month: 'long', year: 'numeric'
    });
}

/** "Academy Dec24, Academy Jan25 and DSML Feb25", or a count once there are many. */
function listBatches(names) {
    if (!names || names.length === 0) return '';
    const sorted = [...names].sort();
    if (sorted.length === 1) return sorted[0];
    if (sorted.length <= 4) {
        return sorted.slice(0, -1).join(', ') + ' and ' + sorted[sorted.length - 1];
    }
    return `${sorted.length} batches, most recently ${sorted[sorted.length - 1]}`;
}
