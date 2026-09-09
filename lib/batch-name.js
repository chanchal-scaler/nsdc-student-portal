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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

export const BATCH_NAME_HINT =
    `Batch names must read as <Programme> <Month><YY> — for example "Academy Sep26", ` +
    `"Academy September26" or "DSML July27". Programme is one of ${PROGRAMMES.join(', ')}; ` +
    `the month may be written out or shortened, from three letters up, in any case; the year is two digits.`;

// The month may be spelled out or cut short, in any case — "Sep26", "sept26",
// "September26" all name the same month, and the existing batches use more than
// one of those. Three letters is the floor, below which "Ma25" could be March
// or May.
const MONTH_PART = /^([A-Za-z]{3,})(\d{2})$/;

function namedMonth(part) {
    const written = MONTH_PART.exec(part);
    if (!written) return null;
    return MONTHS.find(month => month.toLowerCase().startsWith(written[1].toLowerCase())) || null;
}

/**
 * Returns null when the name is in shape, or a sentence saying what is wrong
 * with it — naming the part that does not fit, rather than restating the rule.
 */
export function checkBatchName(name) {
    const value = String(name || '').trim();

    if (!value) return 'batch name is empty';

    const parts = value.split(/\s+/);
    if (parts.length === 2 && PROGRAMMES.includes(parts[0]) && namedMonth(parts[1])) {
        return null;
    }

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

    const written = when.replace(/\d+$/, '');
    const named = written.length >= 3 &&
        MONTHS.find(month => month.toLowerCase().startsWith(written.toLowerCase()));

    if (!named) {
        return `batch name "${value}" does not name a month after the programme`;
    }

    return `batch name "${value}" should end in a two-digit year, like "${programme} ${written}26"`;
}
