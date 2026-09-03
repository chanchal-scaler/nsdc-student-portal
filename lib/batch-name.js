/**
 * The shape a batch name has to take: a programme, then the month's first
 * three letters, then a two-digit year — "Academy Sep26".
 *
 * Batch names are how students find their batch, and NSDC will not refuse a
 * name it has seen before: it creates a second batch called "Academy Sep26(2)"
 * and says nothing. Names that drift — "July25" against "Jul25", "Academy Apr25
 * - Intake 1", "Academy FY23 Pending" — end up as separate batches nobody meant
 * to create, so the shape is fixed here.
 */

// Every programme that appears in the batches created so far. Add to this list
// when a new programme starts; nothing else needs changing.
export const PROGRAMMES = ['Academy', 'DSML', 'DevOps', 'AIML', 'SST', 'OPGP', 'SSB'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const BATCH_NAME_HINT =
    `Batch names must read as <Programme> <Mon><YY> — for example "Academy Sep26" or "DSML Jan27". ` +
    `Programme is one of ${PROGRAMMES.join(', ')}; the month is its first three letters; the year is two digits.`;

const BATCH_NAME_RE = new RegExp(`^(${PROGRAMMES.join('|')}) (${MONTHS.join('|')})\\d{2}$`);

/**
 * Returns null when the name is in shape, or a sentence saying what is wrong
 * with it — naming the part that does not fit, rather than restating the rule.
 */
export function checkBatchName(name) {
    const value = String(name || '').trim();

    if (!value) return 'batch name is empty';
    if (BATCH_NAME_RE.test(value)) return null;

    const parts = value.split(/\s+/);

    if (parts.length !== 2) {
        return `batch name "${value}" must be a programme and a month, like "Academy Sep26"`;
    }

    const [programme, when] = parts;

    if (!PROGRAMMES.includes(programme)) {
        const match = PROGRAMMES.find(p => p.toLowerCase() === programme.toLowerCase());
        return match
            ? `batch name "${value}" should spell the programme "${match}"`
            : `batch name "${value}" starts with "${programme}", which is not one of ${PROGRAMMES.join(', ')}`;
    }

    const month = when.slice(0, 3);
    if (!MONTHS.includes(month)) {
        const match = MONTHS.find(m => when.toLowerCase().startsWith(m.toLowerCase()));
        return match
            ? `batch name "${value}" should write the month as "${match}"`
            : `batch name "${value}" does not name a month after the programme`;
    }

    return `batch name "${value}" should end in a two-digit year, like "${programme} ${month}26"`;
}
