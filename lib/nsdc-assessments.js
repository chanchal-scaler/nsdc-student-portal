import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';
import { promisify } from 'util';
import { isServiceDown } from './nsdc-status.js';
import { describeCall } from './nsdc-call.js';

const delay = promisify(setTimeout);

const USER_SERVICE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';

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
 * The request body that completes one batch: a training, assessment and
 * certification record per candidate.
 *
 * Attendance, the percentage and the grade come from the sheet. They used to be
 * a pair of fixed sets — 90/90/A for a pass, 50/50/D for a fail — inherited from
 * assessment_submission_upload.js, which meant every candidate NSDC holds from
 * us reads identically to every other. What is still fixed is what is genuinely
 * the same for all of them: Scaler assesses and certifies its own candidates,
 * so both agencies are "Self", and the certificate they earn has one name.
 *
 * Both dates are the moment of upload. The certification date used to be set a
 * week earlier than that, for no reason anyone recorded — which put a date that
 * never happened on every certificate this portal has issued.
 */
export function buildAssessmentPayload(batchId, rows, now = new Date()) {
    const uploadedOn = new Date(now).toISOString();

    const candidates = rows.map(row => ({
        candidateID: row.candidateId,
        trainingDetails: {
            trainingStatus: 'Completed',
            attendance: row.attendance
        },
        assessmentDetails: {
            assessmentStatus: row.passed ? 'Pass' : 'Failed',
            assessmentPercentage: row.assessmentPercentage,
            grade: row.grade,
            assessmentDataUploadedOn: uploadedOn,
            assessmentAgency: 'Self',
            assessorID: '',
            assessorName: ''
        },
        certificationDetails: {
            certificationName: 'Scaler NSDC Certificate',
            // The same flag the assessment status is read from: a candidate who
            // passed is certified, and one who did not is not
            isCertified: row.passed,
            certifyingAgency: 'Self',
            certificationDate: uploadedOn
        }
    }));

    return { batchId, candidates };
}

async function submitGroup(client, batchId, rows, csrfToken, authToken) {
    const endpoint = USER_SERVICE_URL + '/v1/candidates/candidate/pushBatchEachCandidate';
    const payload = buildAssessmentPayload(batchId, rows);

    const response = await client(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': authToken
        },
        body: JSON.stringify(payload)
    });

    const raw = (await response.text()).trim();

    if (response.ok) {
        return { status: 'COMPLETED', message: raw.slice(0, 300) };
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
 * Submits results for every group, one call per batch.
 *
 * `groups` is [{ batchId, batchName, rows: [{ email, candidateId, passed, rowNumber }] }].
 * onProgress({ processed, total, completed, failed }) fires after each group.
 */
export async function submitAssessments({ userName, password, groups, onProgress, onResult }) {
    const client = createClient();
    let { csrfToken, authToken } = await authenticate(client, userName, password);

    const results = [];
    let completed = 0;
    let failed = 0;

    for (const group of groups) {
        let attempt = 0;
        let done = false;

        while (!done) {
            try {
                const outcome = await submitGroup(client, group.batchId, group.rows, csrfToken, authToken);
                for (const row of group.rows) {
                    const done = { ...row, batchId: group.batchId, batchName: group.batchName, status: outcome.status, error: '' };
                    results.push(done);
                    if (onResult) await onResult(done);
                }
                completed += group.rows.length;
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

                const retryable = err.httpStatus === 429 || err.httpStatus >= 500;
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
            onProgress({ processed: results.length, total: groups.reduce((n, g) => n + g.rows.length, 0), completed, failed });
        }

        await delay(100);
    }

    return { results, completed, failed };
}
