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

// The shape NSDC gives a candidate ID. Checked because a mistyped one is still a
// real ID belonging to somebody else, which nothing downstream would catch.
const CANDIDATE_ID_RE = /^CAN_\d{1,20}$/i;

// Row checks mirror the existing upload script — email, dob and guardianName —
// with two additions the script did not make: the title has to be one of the
// three that gender can be read from, and phone/countryCode are checked for
// being swapped. Phone length and country code are otherwise left open, so
// students outside India go through unchanged.

// batchName is in REQUIRED_COLUMNS, so a sheet without it is refused — it has to
// be in the template too. Last, to leave the order of sheets already in use alone.
export const TEMPLATE_COLUMNS = ['namePrefix', 'name', 'gender', 'dob', 'guardianName', 'email', 'phone', 'countryCode', 'batchName'];

// Batch sheets already use one consistent set of names across every file in the
// existing uploads, so these are matched as-is (case and spacing aside) rather
// than through an alias list.

// A completion row names a student, a batch and a result. Student and batch can
// each be given as an ID or as something to look the ID up from, the way the
// enrolment sheet takes them — a learner NSDC registered before this portal is
// not in its candidates table, so an email has nothing to resolve against.
export const ASSESSMENT_COLUMNS = ['result'];
// The completion template's columns. No email: by the time results are due,
// both flows have produced candidate IDs — a learner already on NSDC came in
// with theirs from the download, and one this portal registered got theirs back
// from NSDC — and the enrolment run hands over a sheet with both IDs filled in.
// An email column is still read where a sheet carries one.
export const ASSESSMENT_SHEET_COLUMNS = ['candidateId', 'batchId', 'batchName', 'result'];

// An enrolment row names a student and a batch, each of which can be given as
// an ID or as something to look the ID up from. Neither pair is required by
// itself, so the required columns are checked as "one of each" rather than from
// this list; it is here for the template the page hands out.
export const ENROLLMENT_COLUMNS = ['candidateId', 'batchId', 'email', 'batchName'];


// `size` is not in here because it is usually counted from the students already
// uploaded for the batch rather than typed in and left stale. It is accepted as
// an optional column, for a batch made before its students exist.
export const BATCH_COLUMNS = [
    'batchName', 'batchStartDate', 'batchEndDate', 'courseId',
    'trainingHoursPerDay', 'batchStartTime', 'batchEndTime', 'totalFees',
    'feePaidBy', 'assessmentStartDate', 'assessmentEndDate', 'assessmentMode',
    'batchType', 'type', 'skillingCategoryName', 'skillingCategoryId',
    'skillingCategoryScheme', 'schemeId', 'schemeReferenceId', 'tpId', 'tcId'
];

// Counted from the students uploaded for the batch wherever there are any, so
// the sheet does not have to carry it. It is read when the batch is being made
// before its students, where there is nothing to count yet.
export const BATCH_OPTIONAL_COLUMNS = ['size'];

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

    // The student's own name went unchecked while the guardian's was held to
    // this same rule: a row with the name column left blank was uploaded, and
    // NSDC took it. A candidate with no name cannot be found again by anyone.
    if (!row.name) {
        errors.push('name is empty');
    } else if (!NAME_RE.test(row.name)) {
        errors.push(`name "${row.name}" contains unexpected characters`);
    } else if (row.name.length < 2) {
        errors.push(`name "${row.name}" is too short`);
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

    // Optional, and only read where no students have been uploaded to count.
    // A batch created with no room takes nobody: NSDC answers every enrolment
    // into it with "cannot enroll more", so a size of zero is refused here.
    if (row.size !== undefined && row.size !== '') {
        const size = Number(row.size);
        if (!Number.isInteger(size) || size < 1) {
            errors.push(`size "${row.size}" must be a whole number of at least 1`);
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
        const canonical = [...BATCH_COLUMNS, ...BATCH_OPTIONAL_COLUMNS]
            .find(column => normalizeHeader(column) === normalized);
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
/**
 * Reads an assessment sheet: a student, the batch they finished, and whether
 * they passed. The existing script carries the flag as 1/0; Pass/Fail and
 * true/false are accepted too, since a person fills this in by hand.
 */
export async function parseAssessmentSheet(buffer, filename) {
    const isExcel = /\.xlsx?$/i.test(filename);
    const { headers, rows: rawRows } = isExcel ? await readXlsx(buffer) : readCsv(buffer);

    if (headers.length === 0) {
        return {
            rows: [], errors: [], totalRows: 0, mapping: {}, ignoredColumns: [],
            headerErrors: ['The file appears to be empty']
        };
    }

    const CANDIDATE_ID_ALIASES = ['candidateid', 'candidate', 'canid', 'candidatecode'];
    const BATCH_ID_ALIASES = ['batchid', 'batchcode'];
    const BATCH_NAME_ALIASES = ['batchname', 'batch', 'batchtitle'];
    const RESULT_ALIASES = ['result', 'passed', 'pass', 'status', 'assessmentstatus',
        'alldataexiststoupload', 'alldataexists'];

    const mapping = {};
    const unmatched = [];
    for (const header of headers) {
        const normalized = normalizeHeader(header);
        if (!normalized) continue;
        // IDs before the name aliases: "batchId" is not one of them but "batch" is
        if (BATCH_ID_ALIASES.includes(normalized) && !mapping.batchId) mapping.batchId = header;
        else if (CANDIDATE_ID_ALIASES.includes(normalized) && !mapping.candidateId) mapping.candidateId = header;
        else if (COLUMN_ALIASES.email.includes(normalized) && !mapping.email) mapping.email = header;
        else if (BATCH_NAME_ALIASES.includes(normalized) && !mapping.batchName) mapping.batchName = header;
        else if (RESULT_ALIASES.includes(normalized) && !mapping.result) mapping.result = header;
        else unmatched.push(header);
    }

    // One column of each kind is enough; which one is the uploader's choice.
    const headerErrors = [];
    if (!mapping.candidateId && !mapping.email) {
        headerErrors.push(`No column names the student. Add candidateId or email. Found: ${headers.filter(Boolean).join(', ')}`);
    }
    if (!mapping.batchId && !mapping.batchName) {
        headerErrors.push(`No column names the batch. Add batchId or batchName. Found: ${headers.filter(Boolean).join(', ')}`);
    }
    if (!mapping.result) {
        headerErrors.push(`No column gives the result. Add result. Found: ${headers.filter(Boolean).join(', ')}`);
    }
    if (headerErrors.length > 0) {
        return { rows: [], errors: [], totalRows: rawRows.length, mapping, ignoredColumns: unmatched, headerErrors };
    }

    const PASS_VALUES = ['1', 'pass', 'passed', 'true', 'yes', 'y'];
    const FAIL_VALUES = ['0', 'fail', 'failed', 'false', 'no', 'n'];

    const rows = [];
    const errors = [];

    rawRows.forEach((raw, index) => {
        const rowNumber = index + 1; // the first data row is row 1; the header is not counted
        const row = {
            candidateId: String(raw[mapping.candidateId] ?? '').trim().toUpperCase(),
            batchId: String(raw[mapping.batchId] ?? '').trim(),
            email: String(raw[mapping.email] ?? '').trim().toLowerCase(),
            batchName: String(raw[mapping.batchName] ?? '').trim(),
            result: String(raw[mapping.result] ?? '').trim()
        };

        if (!row.candidateId && !row.batchId && !row.email && !row.batchName && !row.result) return;

        const rowErrors = [];

        // An ID goes through as it is; an email has to be looked up, so it is
        // only checked where no ID was given.
        if (row.candidateId) {
            if (!CANDIDATE_ID_RE.test(row.candidateId)) {
                rowErrors.push(`candidateId "${row.candidateId}" is not a candidate ID — they read as CAN_ and digits`);
            }
        } else if (!row.email) {
            rowErrors.push('the row names no student: fill in candidateId or email');
        } else if (!EMAIL_RE.test(row.email)) {
            rowErrors.push(`email "${row.email}" is not a valid address`);
        }

        if (row.batchId) {
            if (!/^\d{1,19}$/.test(row.batchId)) {
                rowErrors.push(`batchId "${row.batchId}" is not a batch ID — they are whole numbers`);
            }
        } else if (!row.batchName) {
            rowErrors.push('the row names no batch: fill in batchId or batchName');
        } else {
            // Only names are held to the shape. A batch given by ID is already on
            // NSDC under whatever it was called.
            const batchNameProblem = checkBatchName(row.batchName);
            if (batchNameProblem) rowErrors.push(batchNameProblem);
        }

        const result = row.result.toLowerCase();
        if (!row.result) {
            rowErrors.push('result is empty (1 for pass, 0 for fail)');
        } else if (!PASS_VALUES.includes(result) && !FAIL_VALUES.includes(result)) {
            rowErrors.push(`result "${row.result}" must be 1/0, Pass/Fail or true/false`);
        }

        if (rowErrors.length > 0) {
            errors.push(...rowErrors.map(message => ({ row: rowNumber, message })));
        } else {
            row.passed = PASS_VALUES.includes(result);
            row.rowNumber = rowNumber;
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

/**
 * Reads an enrolment sheet: one row per enrolment, so the same student can
 * appear on several rows. That is the point of it — an SST student sits in a
 * different batch each year of their tenure, and the student sheet has only one
 * batch column per person to say so with.
 *
 * A row names the student by candidate ID or by email, and the batch by ID or
 * by name. IDs are taken as given; emails and names are resolved later against
 * what earlier uploads stored. Both forms are accepted because neither covers
 * everything: whoever fills the sheet in will not always have IDs to hand, and
 * a batch created on NSDC by hand has no ID stored here to look a name up
 * against.
 */
export async function parseEnrollmentSheet(buffer, filename) {
    const isExcel = /\.xlsx?$/i.test(filename);
    const { headers, rows: rawRows } = isExcel ? await readXlsx(buffer) : readCsv(buffer);

    if (headers.length === 0) {
        return {
            rows: [], errors: [], totalRows: 0, mapping: {}, ignoredColumns: [],
            headerErrors: ['The file appears to be empty']
        };
    }

    const CANDIDATE_ID_ALIASES = ['candidateid', 'candidate', 'canid', 'candidatecode'];
    const BATCH_ID_ALIASES = ['batchid', 'batchcode'];
    const BATCH_NAME_ALIASES = ['batchname', 'batch', 'batchtitle'];

    const mapping = {};
    const unmatched = [];
    for (const header of headers) {
        const normalized = normalizeHeader(header);
        if (!normalized) continue;
        // Checked before the name aliases: "batchId" would otherwise never be
        // reached, since it is not one of them but "batch" is
        if (BATCH_ID_ALIASES.includes(normalized) && !mapping.batchId) mapping.batchId = header;
        else if (CANDIDATE_ID_ALIASES.includes(normalized) && !mapping.candidateId) mapping.candidateId = header;
        else if (COLUMN_ALIASES.email.includes(normalized) && !mapping.email) mapping.email = header;
        else if (BATCH_NAME_ALIASES.includes(normalized) && !mapping.batchName) mapping.batchName = header;
        else unmatched.push(header);
    }

    // One column of each kind is enough. Which one is the uploader's choice, so
    // the sheet is refused only when a whole side of the pairing is missing.
    const headerErrors = [];
    if (!mapping.candidateId && !mapping.email) {
        headerErrors.push(`No column names the student. Add candidateId or email. Found: ${headers.filter(Boolean).join(', ')}`);
    }
    if (!mapping.batchId && !mapping.batchName) {
        headerErrors.push(`No column names the batch. Add batchId or batchName. Found: ${headers.filter(Boolean).join(', ')}`);
    }
    if (headerErrors.length > 0) {
        return { rows: [], errors: [], totalRows: rawRows.length, mapping, ignoredColumns: unmatched, headerErrors };
    }

    const rows = [];
    const errors = [];

    rawRows.forEach((raw, index) => {
        const rowNumber = index + 1; // the first data row is row 1; the header is not counted

        const row = {
            candidateId: String(raw[mapping.candidateId] ?? '').trim().toUpperCase(),
            batchId: String(raw[mapping.batchId] ?? '').trim(),
            email: String(raw[mapping.email] ?? '').trim().toLowerCase(),
            batchName: String(raw[mapping.batchName] ?? '').trim()
        };

        if (!row.candidateId && !row.batchId && !row.email && !row.batchName) return;

        const rowErrors = [];

        // The ID wins where both are given: it is what NSDC is actually sent,
        // and resolving the email as well could only disagree with it.
        if (row.candidateId) {
            if (!/^CAN_\d+$/.test(row.candidateId)) {
                rowErrors.push(`candidateId "${row.candidateId}" is not a candidate ID — they read as CAN_ followed by digits`);
            }
        } else if (!row.email) {
            rowErrors.push('the row names no student: fill in candidateId or email');
        } else if (!EMAIL_RE.test(row.email)) {
            rowErrors.push(`email "${row.email}" is not a valid address`);
        }

        if (row.batchId) {
            if (!/^\d{1,19}$/.test(row.batchId)) {
                rowErrors.push(`batchId "${row.batchId}" is not a batch ID — they are whole numbers`);
            }
        } else if (!row.batchName) {
            rowErrors.push('the row names no batch: fill in batchId or batchName');
        } else {
            // Only names are held to the shape. A batch given by ID is already
            // on NSDC under whatever it was called, and refusing the ID over
            // the name would leave that batch unreachable from here.
            const batchNameProblem = checkBatchName(row.batchName);
            if (batchNameProblem) rowErrors.push(batchNameProblem);
        }

        if (rowErrors.length > 0) {
            errors.push(...rowErrors.map(message => ({ row: rowNumber, message })));
        } else {
            row.rowNumber = rowNumber;
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
