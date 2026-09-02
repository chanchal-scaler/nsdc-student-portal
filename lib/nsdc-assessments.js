import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';
import { promisify } from 'util';

const delay = promisify(setTimeout);

const USER_SERVICE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';

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
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    return { csrfToken, authToken: body.token };
}

/**
 * The request body that completes one batch: a training, assessment and
 * certification record per candidate.
 *
 * The sheet carries a single pass/fail flag per student, so the rest of the
 * record is filled in with the fixed values assessment_submission_upload.js
 * has always sent — Scaler assesses its own candidates ("Self"), and the
 * figures below are what NSDC has been receiving all along.
 */
export function buildAssessmentPayload(batchId, rows, now = new Date()) {
    const assessmentDataUploadedOn = new Date(now);
    const certificationDate = new Date(now);
    certificationDate.setDate(assessmentDataUploadedOn.getDate() - 7);

    const candidates = rows.map(row => {
        const passed = row.passed;
        return {
            candidateID: row.candidateId,
            trainingDetails: {
                trainingStatus: 'Completed',
                attendance: passed ? 90 : 50
            },
            assessmentDetails: {
                assessmentStatus: passed ? 'Pass' : 'Failed',
                assessmentPercentage: passed ? 90 : 50,
                grade: passed ? 'A' : 'D',
                assessmentDataUploadedOn: assessmentDataUploadedOn.toISOString(),
                assessmentAgency: 'Self',
                assessorID: '',
                assessorName: ''
            },
            certificationDetails: {
                certificationName: 'Scaler NSDC Certificate',
                isCertified: passed,
                certifyingAgency: 'Self',
                certificationDate: certificationDate.toISOString()
            }
        };
    });

    return { batchId, candidates };
}

async function submitGroup(client, batchId, rows, csrfToken, authToken) {
    const response = await client(USER_SERVICE_URL + '/v1/candidates/candidate/pushBatchEachCandidate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': authToken
        },
        body: JSON.stringify(buildAssessmentPayload(batchId, rows))
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
    throw error;
}

/**
 * Submits results for every group, one call per batch.
 *
 * `groups` is [{ batchId, batchName, rows: [{ email, candidateId, passed, rowNumber }] }].
 * onProgress({ processed, total, completed, failed }) fires after each group.
 */
export async function submitAssessments({ userName, password, groups, onProgress }) {
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
                    results.push({ ...row, batchId: group.batchId, batchName: group.batchName, status: outcome.status, error: '' });
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
                            results.push({ ...row, batchId: group.batchId, batchName: group.batchName, status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}` });
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

                for (const row of group.rows) {
                    results.push({ ...row, batchId: group.batchId, batchName: group.batchName, status: 'FAILED', error: err.message });
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
