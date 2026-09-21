/**
 * The shape a batch name has to take. Which shape depends on how the programme
 * runs: a monthly intake is named for its month — "Academy Sep26" — while a
 * programme taught in years names the cohort and which year of the course it
 * is — "SST 2023 Year 3".
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

// Programmes taught in years rather than taken in monthly intakes. A student
// sits in a different batch each year of the course, so the month cannot name
// the batch — "SST 2023 Year 3" says which cohort and which of their years.
// Add a programme here when it works that way; nothing else needs changing.
export const YEAR_WISE_PROGRAMMES = ['SST'];

// The courses an SST batch can be for. Kept as a list for the same reason
// PROGRAMMES is: a free-form code would let "CS-AI", "CSAI" and "cs-ai" name
// three batches. Add a course here when one starts; nothing else changes.
export const SST_COURSES = ['CS-AI', 'AI-B'];

// "2023 CS-AI Year 3", or "2023 Year 3" for the batches made before the course
// was part of the name. The year is four digits and the number is a single one,
// because no course here runs past nine years and "Year 33" is a typo.
const YEAR_PART = new RegExp(
    `^(\\d{4})\\s+(?:(${SST_COURSES.map(c => c.replace(/-/g, '\\-')).join('|')})\\s+)?Year\\s+([1-9])$`, 'i');

// A month can hold more than one online batch, so a name may end in a number
// in brackets — "Academy Sep26 (1)". The space matters: NSDC's own rename of a
// clashing name has none — "Academy Sep26(2)" — and telling a batch somebody
// meant to make from one NSDC made behind our back is worth keeping.
const RUN_SUFFIX = /\s\((\d{1,2})\)$/;
const NSDC_RENAME = /\S\(\d{1,2}\)$/;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

const MONTHLY_PROGRAMMES = PROGRAMMES.filter(p => !YEAR_WISE_PROGRAMMES.includes(p));

export const BATCH_NAME_HINT =
    `Batch names for ${MONTHLY_PROGRAMMES.join(', ')} must read as <Programme> <Month><YY> — ` +
    `for example "Academy Sep26", "Academy September26" or "DSML July27"; the month may be ` +
    `written out or shortened, from three letters up, in any case, and the year is two digits. ` +
    `${YEAR_WISE_PROGRAMMES.join(', ')} runs in years, so its batches read as ` +
    `<Programme> <YYYY> <Course> Year <n> — for example "SST 2023 ${SST_COURSES[0]} Year 3"; ` +
    `the course is one of ${SST_COURSES.join(', ')}, and may be left out on batches named before it was used.`;

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

    if (NSDC_RENAME.test(value)) {
        return `batch name "${value}" looks like the name NSDC makes when one already exists. ` +
            `A batch meant to be numbered puts a space before the bracket, like "Academy Sep26 (1)"`;
    }

    // Checked without the run number, so "Academy Sep26 (1)" is held to the same
    // shape as "Academy Sep26" rather than needing a rule of its own
    const base = value.replace(RUN_SUFFIX, '');
    const parts = base.split(/\s+/);
    let programme = parts[0] || '';

    // Correct the case before routing, so "sst 2023 Year 3" is told to spell the
    // programme rather than handed the monthly programmes' message
    const spelled = PROGRAMMES.find(p => p.toLowerCase() === programme.toLowerCase());
    if (spelled && spelled !== programme) {
        return `batch name "${base}" should spell the programme "${spelled}"`;
    }

    // A programme taught in years is held to its own shape and only that one.
    // Letting it take the monthly shape as well would put one cohort under two
    // legal names, which is the split this file exists to stop.
    if (YEAR_WISE_PROGRAMMES.includes(programme)) {
        const rest = parts.slice(1).join(' ');
        if (YEAR_PART.test(rest)) return null;
        return `batch name "${base}" must be a programme, a four-digit year, the course ` +
            `(${SST_COURSES.join(' or ')}) and which year of it, like "${programme} 2023 ${SST_COURSES[0]} Year 3"`;
    }

    if (parts.length === 2 && PROGRAMMES.includes(programme) && namedMonth(parts[1])) {
        return null;
    }

    if (parts.length !== 2) {
        // Named here rather than in the generic message: a year-wise name typed
        // against a monthly programme is a different mistake from a stray word.
        const wrongShape = PROGRAMMES.includes(programme) && YEAR_PART.test(parts.slice(1).join(' '));
        return wrongShape
            ? `batch name "${base}" names a year, but ${programme} runs in monthly intakes — ` +
              `name it for its month, like "${programme} Sep26"`
            : `batch name "${base}" must be a programme and a month, like "Academy Sep26"`;
    }

    const [, when] = parts;

    if (!PROGRAMMES.includes(programme)) {
        const match = PROGRAMMES.find(p => p.toLowerCase() === programme.toLowerCase());
        return match
            ? `batch name "${base}" should spell the programme "${match}"`
            : `batch name "${base}" starts with "${programme}", which is not one of ${PROGRAMMES.join(', ')}`;
    }

    const written = when.replace(/\d+$/, '');
    const named = written.length >= 3 &&
        MONTHS.find(month => month.toLowerCase().startsWith(written.toLowerCase()));

    if (!named) {
        return `batch name "${base}" does not name a month after the programme`;
    }

    return `batch name "${base}" should end in a two-digit year, like "${programme} ${written}26"`;
}
