import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';
import { promisify } from 'util';
import { isServiceDown } from './nsdc-status.js';

const delay = promisify(setTimeout);

// Points at NSDC itself unless overridden — set NSDC_BASE_URL to the mock
// server (tools/mock-nsdc-server.js) to exercise the full flow without
// touching the real service.
const USER_SERVICE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';

// With DRY_RUN on, no request ever leaves this machine: rows are validated and
// fake candidate IDs are returned so the whole flow can be exercised locally
// without creating real candidates on NSDC (there is no staging environment).
const DRY_RUN = process.env.NSDC_DRY_RUN === '1';

export const isDryRun = DRY_RUN;

function createClient() {
    return fetchCookieModule(fetch, new CookieJar());
}

async function getCsrfToken(client) {
    const response = await client(USER_SERVICE_URL + '/api/user/v1', { method: 'HEAD' });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const csrfToken = response.headers.get('X-Csrf-Token');
    if (!csrfToken) {
        throw new Error('CSRF token not found in response headers');
    }
    return csrfToken;
}

async function getPublicKey(client, csrfToken) {
    const response = await client(USER_SERVICE_URL + '/api/user/v1/getkey', {
        headers: { 'X-Csrf-Token': csrfToken }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

function encryptPassword(publicKeyPem, password, secret) {
    const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
    const encrypted = publicKey.encrypt(password, 'RSA-OAEP', { md: forge.md.sha256.create() });
    return forge.util.encode64(encrypted) + secret;
}

async function authenticate(client, userName, password) {
    const csrfToken = await getCsrfToken(client);
    const { publicKey, secret } = await getPublicKey(client, csrfToken);
    const encryptedPassword = encryptPassword(publicKey, password, secret);

    const response = await client(USER_SERVICE_URL + '/api/user/v1/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken
        },
        body: JSON.stringify({ userName, password: encryptedPassword })
    });

    if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    return { csrfToken, authToken: body.token };
}

/**
 * Builds the exact JSON body that would be POSTed for one student. Exported so
 * the portal can show the payload without registering anybody on NSDC.
 */
export function buildPayload(student) {
    // Mirrors the existing upload script exactly: gender comes from namePrefix
    // (the sheet's own gender column is not sent) and fatherName repeats
    // guardianName, so candidates created here match the ones already on NSDC.
    // Only Mr./Mrs./Ms. reach this point — the sheet check rejects any other
    // title — so "not Mr." meaning female is a safe read, not a guess.
    const prefix = (student.namePrefix || '').trim();
    const gender = prefix === 'Mr.' || prefix === 'Mr' ? 'male' : 'female';

    return {
        personalDetails: {
            namePrefix: student.namePrefix,
            firstName: student.name,
            gender,
            dob: `${student.dob}T00:00:00.000Z`,
            fatherName: student.guardianName,
            guardianName: student.guardianName
        },
        contactDetails: {
            email: student.email,
            phone: parseInt(student.phone, 10),
            countryCode: student.countryCode
        }
    };
}

/**
 * Registers one candidate. NSDC answers an already-registered student with an
 * error whose message carries their existing CAN_ id, so a duplicate is a
 * usable result rather than a failure — the same row can be re-uploaded safely.
 */
async function createCandidate(client, student, csrfToken, authToken) {
    if (DRY_RUN) {
        await delay(20);
        const fakeId = 'CAN_9' + String(Math.floor(Math.random() * 9000000) + 1000000);
        return { candidateId: fakeId, status: 'NEW' };
    }

    const response = await client(USER_SERVICE_URL + '/api/user/v1/register/Candidate/v1', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': authToken
        },
        body: JSON.stringify(buildPayload(student))
    });

    if (response.ok) {
        const body = await response.json();
        if (!body.candidateId) {
            throw new Error('NSDC accepted the row but returned no candidateId');
        }
        return { candidateId: body.candidateId, status: 'NEW' };
    }

    const errorBody = await response.json().catch(() => ({ message: response.statusText }));
    const message = errorBody.message || response.statusText;
    const existing = message.match(/CAN_\d+/);

    if (existing) {
        return { candidateId: existing[0], status: 'DUPLICATE', error: message };
    }

    const error = new Error(message);
    error.httpStatus = response.status;
    throw error;
}

/**
 * Uploads every row, one at a time, in sheet order.
 *
 * onProgress({ processed, total, created, duplicates, failed }) is called after
 * each row. Resolves to { results } where every entry carries the original row
 * plus candidateId/status/error, so the result sheet keeps the sheet's order.
 */
export async function uploadStudents({ userName, password, students, onProgress, onResult }) {
    const client = createClient();

    let csrfToken = null;
    let authToken = null;
    if (!DRY_RUN) {
        ({ csrfToken, authToken } = await authenticate(client, userName, password));
    }

    const results = [];
    let created = 0;
    let duplicates = 0;
    let failed = 0;

    for (const student of students) {
        let attempt = 0;
        let done = false;

        while (!done) {
            try {
                const outcome = await createCandidate(client, student, csrfToken, authToken);
                const row = { ...student, ...outcome };
                results.push(row);
                if (onResult) await onResult(row);
                if (outcome.status === 'DUPLICATE') duplicates++; else created++;
                done = true;
            } catch (err) {
                attempt++;

                // 412 means the CSRF token or session expired mid-run: re-authenticate
                // once and retry the same row rather than losing it.
                if (err.httpStatus === 412 && attempt === 1) {
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch (reAuthError) {
                        results.push({ ...student, candidateId: '', status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}` });
                        failed++;
                        done = true;
                        break;
                    }
                }

                if (err.httpStatus === 429 && attempt <= 3) {
                    await delay(Math.min(1000 * 2 ** attempt, 30000));
                    continue;
                }

                // A service that is down will fail every remaining row the same
                // way; stop and say so rather than burning through the sheet.
                if (isServiceDown(err)) {
                    err.serviceDown = true;
                    throw err;
                }

                const failedRow = { ...student, candidateId: '', status: 'FAILED', error: err.message };
                results.push(failedRow);
                if (onResult) await onResult(failedRow);
                failed++;
                done = true;
            }
        }

        if (onProgress) {
            onProgress({ processed: results.length, total: students.length, created, duplicates, failed });
        }

        await delay(100); // same pacing the existing script uses
    }

    return { results, created, duplicates, failed };
}
