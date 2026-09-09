import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';
import { promisify } from 'util';
import { isServiceDown } from './nsdc-status.js';
import { describeCall } from './nsdc-call.js';

const delay = promisify(setTimeout);

const USER_SERVICE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';

const REQUEST_TIMEOUT_MS = 60000;

function createClient() {
    return fetchCookieModule(fetch, new CookieJar());
}

async function getCsrfToken(client) {
    const endpoint = USER_SERVICE_URL + '/api/user/v1';
    const response = await client(endpoint, { method: 'HEAD' });
    if (!response.ok) {
        const error = new Error(`HTTP error! status: ${response.status}`);
        error.httpStatus = response.status;
        error.call = describeCall({ endpoint, method: 'HEAD', status: response.status });
        throw error;
    }
    const csrfToken = response.headers.get('X-Csrf-Token');
    if (!csrfToken) {
        throw new Error('CSRF token not found in response headers');
    }
    return csrfToken;
}

async function getPublicKey(client, csrfToken) {
    const endpoint = USER_SERVICE_URL + '/api/user/v1/getkey';
    const response = await client(endpoint, {
        headers: { 'X-Csrf-Token': csrfToken }
    });
    if (!response.ok) {
        const error = new Error(`HTTP error! status: ${response.status}`);
        error.httpStatus = response.status;
        error.call = describeCall({ endpoint, method: 'GET', status: response.status });
        throw error;
    }
    return response.json();
}

async function authenticate(client, userName, password) {
    const csrfToken = await getCsrfToken(client);
    const { publicKey, secret } = await getPublicKey(client, csrfToken);
    const encrypted = forge.pki.publicKeyFromPem(publicKey)
        .encrypt(password, 'RSA-OAEP', { md: forge.md.sha256.create() });
    const encryptedPassword = forge.util.encode64(encrypted) + secret;

    const response = await client(USER_SERVICE_URL + '/api/user/v1/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken
        },
        body: JSON.stringify({ userName, password: encryptedPassword })
    });

    if (!response.ok) {
        const error = new Error(`Authentication failed: ${response.status} ${response.statusText}`);
        error.httpStatus = response.status;
        error.call = describeCall({
            endpoint: USER_SERVICE_URL + '/api/user/v1/login',
            status: response.status,
            responseBody: response.statusText
        });
        throw error;
    }

    const body = await response.json();
    return { csrfToken, authToken: body.token };
}

/**
 * The request body for enrolling one batch's worth of candidates. Exported so
 * the portal can show it without enrolling anybody.
 */
export function buildEnrollmentPayload(batchId, candidateIds) {
    return { batchId, candidateIds };
}

/**
 * Enrolls one group. NSDC answers a repeat enrolment with 409 and an "already"
 * message, which the existing script treats as success — the candidates are in
 * the batch either way, which is the outcome that was asked for.
 */
async function enrollGroup(client, batchId, candidateIds, csrfToken, authToken) {
    const endpoint = USER_SERVICE_URL + '/api/thirdparty/v1/enroll/Candidate';
    const payload = buildEnrollmentPayload(batchId, candidateIds);

    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS));

    const request = client(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': authToken
        },
        body: JSON.stringify(payload)
    });

    const response = await Promise.race([request, timeout]);
    const raw = (await response.text()).trim();

    if (response.ok) {
        return { status: 'ENROLLED', message: raw.slice(0, 300) };
    }

    // Already in the batch — the script counts this as done, not as a failure
    if (response.status === 409 && /already|cannot enroll more/i.test(raw)) {
        return { status: 'ALREADY_ENROLLED', message: raw.slice(0, 300) };
    }

    let message = raw;
    try {
        const body = JSON.parse(raw);
        message = body.message || body.error || `HTTP ${response.status}`;
    } catch { /* plain text error, use it as-is */ }

    const error = new Error(message || `HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.call = describeCall({ endpoint, payload, status: response.status, responseBody: raw });
    throw error;
}

/**
 * Enrols every group, one call per batch.
 *
 * `groups` is [{ batchId, batchName, rows: [{ email, candidateId, rowNumber }] }].
 * onProgress({ processed, total, enrolled, alreadyEnrolled, failed }) fires after
 * each group; counts are students, not groups. Resolves to per-row results so
 * the result sheet keeps the sheet's own order.
 */
export async function enrollCandidates({ userName, password, groups, onProgress, onResult }) {
    const client = createClient();
    let { csrfToken, authToken } = await authenticate(client, userName, password);

    const results = [];
    let enrolled = 0;
    let alreadyEnrolled = 0;
    let failed = 0;

    for (const group of groups) {
        const candidateIds = group.rows.map(row => row.candidateId);
        let attempt = 0;
        let done = false;

        while (!done) {
            try {
                const outcome = await enrollGroup(client, group.batchId, candidateIds, csrfToken, authToken);

                for (const row of group.rows) {
                    const done = { ...row, batchId: group.batchId, batchName: group.batchName, status: outcome.status, error: '' };
                    results.push(done);
                    if (onResult) await onResult(done);
                }
                if (outcome.status === 'ENROLLED') enrolled += group.rows.length;
                else alreadyEnrolled += group.rows.length;
                done = true;
            } catch (err) {
                attempt++;

                if (err.httpStatus === 412 && attempt === 1) {
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch (reAuthError) {
                        for (const row of group.rows) {
                            const failedRow = { ...row, batchId: group.batchId, batchName: group.batchName, status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}`, call: reAuthError.call || describeCall({ endpoint: USER_SERVICE_URL + '/api/user/v1/login', responseBody: reAuthError.message }), attempts: attempt };
                            results.push(failedRow);
                            if (onResult) await onResult(failedRow);
                        }
                        failed += group.rows.length;
                        done = true;
                        break;
                    }
                }

                const retryable = err.httpStatus === 429 || err.httpStatus >= 500 || /timeout/i.test(err.message);
                if (retryable && attempt <= 3) {
                    await delay(Math.min(1000 * 2 ** attempt, 30000));
                    continue;
                }

                if (isServiceDown(err)) {
                    err.serviceDown = true;
                    throw err;
                }

                for (const row of group.rows) {
                    const failedRow = { ...row, batchId: group.batchId, batchName: group.batchName, status: 'FAILED', error: err.message, call: err.call || null, attempts: attempt };
                    results.push(failedRow);
                    if (onResult) await onResult(failedRow);
                }
                failed += group.rows.length;
                done = true;
            }
        }

        if (onProgress) {
            onProgress({ processed: results.length, total: groups.reduce((n, g) => n + g.rows.length, 0), enrolled, alreadyEnrolled, failed });
        }

        await delay(100);
    }

    return { results, enrolled, alreadyEnrolled, failed };
}
