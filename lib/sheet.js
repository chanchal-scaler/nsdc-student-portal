import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { checkBatchName } from './batch-name.js';

// Column names people actually use in the sheets NSDC uploads have come from.
// Everything is matched case-insensitively with spaces/underscores stripped, so
// "Student Name", "student_name" and "STUDENTNAME" all land on `name`.
const COLUMN_ALIASES = {
    namePrefix: ['nameprefix', 'prefix', 'title', 'salutation'],
    name: ['name', 'studentname', 'fullname', 'candidatename', 'firstname'],
    gender: ['gender', 'sex'],
    dob: ['dob', 'dateofbirth', 'birthdate'],
    guardianName: ['guardianname', 'guardian', 'fathersname', 'fathername', 'parentname'],
    email: ['email', 'emailid', 'emailaddress', 'mail'],
    phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber'],
    countryCode: ['countrycode', 'isdcode', 'code'],
    // Optional. Student sheets often already name the batch each row belongs
    // to, under one of these headings, which is enough to build the enrolment
    // sheet without anyone pairing them up by hand afterwards.
    batchName: ['batchname', 'batch', 'course', 'program', 'programme', 'intake']
};

// Columns the upload cannot run without. `gender` is deliberately absent: NSDC
// derives it from namePrefix, matching the existing script's behaviour.
const REQUIRED_COLUMNS = ['namePrefix', 'name', 'dob', 'guardianName', 'email', 'phone', 'batchName'];

// Row checks mirror the existing upload script — email, dob and guardianName —
// with two additions the script did not make: the title has to be one of the
// three that gender can be read from, and phone/countryCode are checked for
// being swapped. Phone length and country code are otherwise left open, so
// students outside India go through unchanged.

export const TEMPLATE_COLUMNS = ['namePrefix', 'name', 'gender', 'dob', 'guardianName', 'email', 'phone', 'countryCode'];

// Batch sheets already use one consistent set of names across every file in the
// existing uploads, so these are matched as-is (case and spacing aside) rather
// than through an alias list.



// `size` is deliberately absent: it is counted from the students already
// uploaded for that batch rather than typed in and left stale.
export const BATCH_COLUMNS = [
    'batchName', 'batchStartDate', 'batchEndDate', 'courseId',
    'trainingHoursPerDay', 'batchStartTime', 'batchEndTime', 'totalFees',
    'feePaidBy', 'assessmentStartDate', 'assessmentEndDate', 'assessmentMode',
    'batchType', 'type', 'skillingCategoryName', 'skillingCategoryId',
    'skillingCategoryScheme', 'schemeId', 'schemeReferenceId', 'tpId', 'tcId'
];

function normalizeHeader(header) {
    return String(header || '').toLowerCase().replace(/[\s_\-.'\u2019]/g, '');
}

/**
 * Maps the sheet's own header row onto our canonical field names.
 * Returns { mapping: {canonical: sheetHeader}, unmatched: [sheetHeader] }.
 */
function mapHeaders(headers) {
    const mapping = {};
    const unmatched = [];

    for (const header of headers) {
        const normalized = normalizeHeader(header);
        if (!normalized) continue;

        const canonical = Object.keys(COLUMN_ALIASES)
            .find(key => COLUMN_ALIASES[key].includes(normalized));

        if (!canonical) {
            unmatched.push(header);
        } else if (!(canonical in mapping)) {
            // First matching column wins — a sheet with guardianName twice keeps
            // the left-hand one rather than silently taking whichever came last.
            mapping[canonical] = header;
        }
    }

    return { mapping, unmatched };
}

async function readXlsx(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('The Excel file has no sheets');

    const rows = [];
    let headers = null;

    sheet.eachRow({ includeEmpty: false }, row => {
        const values = [];
        row.eachCell({ includeEmpty: true }, cell => {
            let value = cell.value;
            if (value && typeof value === 'object') {
                // Hyperlinked or rich-text cells carry an object, dates a Date
                if (value instanceof Date) value = value.toISOString().slice(0, 10);
                else if ('text' in value) value = value.text;
                else if ('result' in value) value = value.result;
                else value = '';
            }
            values.push(value === null || value === undefined ? '' : String(value).trim());
        });

        if (!headers) {
            headers = values;
        } else {
            const record = {};
            headers.forEach((header, i) => { record[header] = values[i] ?? ''; });
            rows.push(record);
        }
    });

    return { headers: headers || [], rows };
}

function readCsv(buffer) {
    const records = parseCsv(buffer, {
        columns: false,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
        trim: true,
        // A sheet edited on both Windows and a Mac ends up with mixed line
        // endings. Left to auto-detect, the parser locks onto the first one it
        // sees and silently glues the following rows into one long record.
        record_delimiter: ['\r\n', '\n', '\r']
    });

    if (records.length === 0) return { headers: [], rows: [] };

    const headers = records[0];
    const rows = records.slice(1).map(values => {
        const record = {};
        headers.forEach((header, i) => { record[header] = values[i] ?? ''; });
        return record;
    });

    return { headers, rows };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[a-zA-Z\s.'-]+$/;

// Only these three titles are accepted. Gender is derived from the title
// (Mr. is male, Mrs. and Ms. are female) and nothing else in the sheet says
// which it is, so a title like Dr. or Prof. would silently record the student
// as female. A rejected row is fixed in the sheet in seconds; a wrong gender on
// NSDC is not. Written with the dot and matched case-insensitively, so "mr",
// "MRS" and "Ms." all pass and are normalised to the canonical form.
const ALLOWED_PREFIXES = { 'mr': 'Mr.', 'mr.': 'Mr.', 'mrs': 'Mrs.', 'mrs.': 'Mrs.', 'ms': 'Ms.', 'ms.': 'Ms.' };
export const PREFIX_OPTIONS = ['Mr.', 'Mrs.', 'Ms.'];

/** The canonical form of a title, or null where it is not one of the three. */
export function canonicalPrefix(value) {
    return ALLOWED_PREFIXES[String(value || '').trim().toLowerCase()] || null;
}

function validateRow(row, rowNumber) {
    const errors = [];

    if (!row.namePrefix) {
        errors.push(`namePrefix is empty (one of ${PREFIX_OPTIONS.join(', ')})`);
    } else if (!canonicalPrefix(row.namePrefix)) {
        errors.push(`namePrefix "${row.namePrefix}" must be one of ${PREFIX_OPTIONS.join(', ')}`);
    }

    if (!row.email) {
        errors.push('email is empty');
    } else if (!EMAIL_RE.test(row.email)) {
        errors.push(`email "${row.email}" is not a valid address`);
    }

    if (!row.dob) {
        errors.push('dob is empty');
    } else if (!DOB_RE.test(row.dob)) {
        // Deliberately not guessing: 6/7/1991 could be June 7th or July 6th, and
        // a wrong date of birth is near-impossible to correct on NSDC afterwards.
        errors.push(`dob "${row.dob}" must be written as YYYY-MM-DD (e.g. 1991-06-07)`);
    } else {
        const parsed = new Date(row.dob + 'T00:00:00Z');
        if (Number.isNaN(parsed.getTime()) || row.dob !== parsed.toISOString().slice(0, 10)) {
            errors.push(`dob "${row.dob}" is not a real date`);
        } else if (parsed > new Date()) {
            errors.push(`dob "${row.dob}" is in the future`);
        } else if (parsed < new Date('1900-01-01T00:00:00Z')) {
            errors.push(`dob "${row.dob}" is before 1900`);
        }
    }

    if (!row.guardianName) {
        errors.push('guardianName is empty');
    } else if (!NAME_RE.test(row.guardianName)) {
        errors.push(`guardianName "${row.guardianName}" contains unexpected characters`);
    } else if (row.guardianName.length < 2) {
        errors.push(`guardianName "${row.guardianName}" is too short`);
    }

    const batchNameProblem = checkBatchName(row.batchName);
    if (batchNameProblem) {
        errors.push(batchNameProblem);
    }

    // 512 candidates on NSDC have a country code where their phone number
    // belongs: a sheet where the phone and countryCode columns were the other
    // way round went through unchecked. Both are checked now, and the swap is
    // named for what it is. Phone length is left open — students outside India
    // have numbers that are not ten digits — so the swap is only called where
    // the two columns are unambiguously the wrong way round.
    const phone = row.phone.replace(/[\s\-()]/g, '');
    const countryCode = row.countryCode.replace(/^\+/, '');

    if (phone && countryCode && /^\d{1,4}$/.test(phone) && /^\d{6,15}$/.test(countryCode)) {
        errors.push(`phone "${row.phone}" and countryCode "${row.countryCode}" look swapped`);
    } else {
        if (!phone) {
            errors.push('phone is empty');
        } else if (!/^\d{6,15}$/.test(phone)) {
            errors.push(`phone "${row.phone}" must be 6 to 15 digits`);
        }

        if (!countryCode) {
            errors.push('countryCode is empty');
        } else if (!/^\d{1,4}$/.test(countryCode)) {
            errors.push(`countryCode "${row.countryCode}" must be 1 to 4 digits`);
        }
    }

    return errors.map(message => ({ row: rowNumber, message }));
}

/**
 * Reads an uploaded students sheet (.csv or .xlsx) and returns canonical rows
 * plus every problem found. Nothing is sent to NSDC from here.
 *
 * Returns { rows, errors, headerErrors, mapping, ignoredColumns, totalRows }.
 */
export async function parseStudentSheet(buffer, filename) {
    const isExcel = /\.xlsx?$/i.test(filename);
    const { headers, rows: rawRows } = isExcel ? await readXlsx(buffer) : readCsv(buffer);

    if (headers.length === 0) {
        return {
            rows: [], errors: [], totalRows: 0, mapping: {}, ignoredColumns: [],
            headerErrors: ['The file appears to be empty']
        };
    }

    const { mapping, unmatched } = mapHeaders(headers);
    const missing = REQUIRED_COLUMNS.filter(column => !(column in mapping));

    if (missing.length > 0) {
        return {
            rows: [], errors: [], totalRows: rawRows.length, mapping, ignoredColumns: unmatched,
            headerErrors: [`Missing column(s): ${missing.join(', ')}. Found: ${headers.filter(Boolean).join(', ')}`]
        };
    }

    const rows = [];
    const errors = [];

    rawRows.forEach((raw, index) => {
        // The first data row is row 1. The header is not counted, so a row
        // number here is its position among the students, not its line in the
        // file — the file's own line is one higher.
        const rowNumber = index + 1;

        const row = {};
        for (const [canonical, header] of Object.entries(mapping)) {
            row[canonical] = String(raw[header] ?? '').trim();
        }

        // Fully blank lines are skipped rather than reported as eight errors each
        if (Object.values(row).every(value => value === '')) return;

        row.email = row.email.toLowerCase();
        // Stored in canonical form so the payload's namePrefix and the gender
        // derived from it always agree, whatever casing the sheet used
        row.namePrefix = canonicalPrefix(row.namePrefix) || row.namePrefix;
        row.rowNumber = rowNumber;
        // Carried through untouched; whether it names a real batch is decided
        // later, against what the batch uploads actually created.
        row.batchName = row.batchName || '';

        const rowErrors = validateRow(row, rowNumber);
        if (rowErrors.length > 0) {
            errors.push(...rowErrors);
        } else {
            rows.push(row);
        }
    });

    return {
        rows,
        errors,
        headerErrors: [],
        mapping,
        ignoredColumns: unmatched,
        totalRows: rows.length + new Set(errors.map(e => e.row)).size
    };
}

function validateBatchRow(row, rowNumber) {
    const errors = [];

    // The upload script feeds these straight to parseInt and new Date, where a
    // bad value becomes NaN or "Invalid Date" and NSDC rejects the batch with a
    // message that does not say which field was wrong. Catching it here names it.
    const numeric = ['trainingHoursPerDay', 'totalFees', 'skillingCategoryId'];
    for (const field of numeric) {
        if (!row[field]) {
            errors.push(`${field} is empty`);
        } else if (Number.isNaN(parseInt(row[field], 10))) {
            errors.push(`${field} "${row[field]}" is not a number`);
        }
    }

    const dates = ['batchStartDate', 'batchEndDate', 'batchStartTime', 'batchEndTime',
        'assessmentStartDate', 'assessmentEndDate'];
    for (const field of dates) {
        if (!row[field]) {
            errors.push(`${field} is empty`);
        } else if (Number.isNaN(new Date(row[field]).getTime())) {
            errors.push(`${field} "${row[field]}" is not a date this can read`);
        }
    }

    const text = ['courseId', 'feePaidBy', 'assessmentMode', 'batchType',
        'type', 'skillingCategoryName', 'skillingCategoryScheme', 'schemeId',
        'schemeReferenceId', 'tpId', 'tcId'];
    for (const field of text) {
        if (!row[field]) errors.push(`${field} is empty`);
    }

    const batchNameProblem = checkBatchName(row.batchName);
    if (batchNameProblem) errors.push(batchNameProblem);

    return errors.map(message => ({ row: rowNumber, message }));
}

/**
 * Reads an uploaded batch sheet (.csv or .xlsx). Same contract as
 * parseStudentSheet: nothing is sent to NSDC from here.
 */
export async function parseBatchSheet(buffer, filename) {
    const isExcel = /\.xlsx?$/i.test(filename);
    const { headers, rows: rawRows } = isExcel ? await readXlsx(buffer) : readCsv(buffer);

    if (headers.length === 0) {
        return {
            rows: [], errors: [], totalRows: 0, mapping: {}, ignoredColumns: [],
            headerErrors: ['The file appears to be empty']
        };
    }

    // Match on the normalised header so "Batch Name" and "batchname" both land
    // on batchName, but without the alias guessing the student sheet needs.
    const mapping = {};
    const unmatched = [];
    for (const header of headers) {
        const normalized = normalizeHeader(header);
        if (!normalized) continue;
        const canonical = BATCH_COLUMNS.find(column => normalizeHeader(column) === normalized);
        if (!canonical) unmatched.push(header);
        else if (!(canonical in mapping)) mapping[canonical] = header;
    }

    const missing = BATCH_COLUMNS.filter(column => !(column in mapping));
    if (missing.length > 0) {
        return {
            rows: [], errors: [], totalRows: rawRows.length, mapping, ignoredColumns: unmatched,
            headerErrors: [`Missing column(s): ${missing.join(', ')}. Found: ${headers.filter(Boolean).join(', ')}`]
        };
    }

    const rows = [];
    const errors = [];

    rawRows.forEach((raw, index) => {
        const rowNumber = index + 1; // the first data row is row 1; the header is not counted

        const row = {};
        for (const [canonical, header] of Object.entries(mapping)) {
            row[canonical] = String(raw[header] ?? '').trim();
        }

        if (Object.values(row).every(value => value === '')) return;

        row.rowNumber = rowNumber;

        const rowErrors = validateBatchRow(row, rowNumber);
        if (rowErrors.length > 0) {
            errors.push(...rowErrors);
        } else {
            rows.push(row);
        }
    });

    return {
        rows,
        errors,
        headerErrors: [],
        mapping,
        ignoredColumns: unmatched,
        totalRows: rows.length + new Set(errors.map(e => e.row)).size
    };
}
