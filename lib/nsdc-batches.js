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
 * Builds the exact JSON body that would be POSTed for one batch. Exported so
 * the portal can show the payload without creating anything on NSDC.
 *
 * Mirrors batch_details_upload.js field for field, including the three values
 * that script hardcodes rather than reading from the sheet: sector, schemeType
 * and createdSource.
 */
export function buildBatchPayload(batch) {
    return {
        batchName: batch.batchName,
        // Counted from the students uploaded for this batch, not typed into the
        // sheet where it would drift from the real intake.
        size: batch.size,
        batchStartDate: new Date(batch.batchStartDate).toISOString(),
        batchEndDate: new Date(batch.batchEndDate).toISOString(),
        courseId: batch.courseId,
        trainingHoursPerDay: parseInt(batch.trainingHoursPerDay, 10),
        batchStartTime: new Date(batch.batchStartTime).toISOString(),
        batchEndTime: new Date(batch.batchEndTime).toISOString(),
        batchFee: {
            totalFees: parseInt(batch.totalFees, 10)
        },
        sector: {
            name: 'IT-ITeS'
        },
        feePaidBy: batch.feePaidBy,
        assessmentStartDate: new Date(batch.assessmentStartDate).toISOString(),
        assessmentEndDate: new Date(batch.assessmentEndDate).toISOString(),
        assessmentMode: batch.assessmentMode,
        batchType: batch.batchType,
        type: batch.type,
        skillingcategory: {
            name: batch.skillingCategoryName,
            id: parseInt(batch.skillingCategoryId, 10),
            scheme: batch.skillingCategoryScheme
        },
        schemeId: batch.schemeId,
        schemeReferenceId: batch.schemeReferenceId,
        schemeType: 'NON-PMKVY',
        tpId: batch.tpId,
        tcId: batch.tcId,
        createdSource: 'Created for NSDC Academy Partners'
    };
}

async function createBatch(client, batch, csrfToken, authToken) {
    const endpoint = USER_SERVICE_URL + '/api/batch/v1/create';
    const payload = buildBatchPayload(batch);

    const response = await client(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': authToken
        },
        body: JSON.stringify(payload)
    }).catch(err => {
        // A request that never reached NSDC is still a failed call worth
        // recording, with the payload that would have gone
        err.call = describeCall({ endpoint, payload, responseBody: err.message });
        throw err;
    });

    const raw = await response.text();

    if (response.ok) {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* handled by the batchId check */ }
        if (!body.batchId) {
            const error = new Error('NSDC accepted the batch but returned no batchId');
            error.call = describeCall({ endpoint, payload, status: response.status, responseBody: raw });
            throw error;
        }
        // NSDC renames a clashing batch — "Academy Dec25" can come back as
        // "Academy Dec25(2)" — so the returned name is what actually exists.
        return { batchId: body.batchId, batchName: body.batchName || batch.batchName, status: 'CREATED' };
    }

    let errorBody = {};
    try { errorBody = JSON.parse(raw); } catch { /* plain text error, use it as-is */ }
    const error = new Error(errorBody.message || raw.slice(0, 300) || response.statusText);
    error.httpStatus = response.status;
    error.call = describeCall({ endpoint, payload, status: response.status, responseBody: raw });
    throw error;
}

/**
 * Creates every batch in the sheet, one at a time, in sheet order.
 *
 * onProgress({ processed, total, created, failed }) is called after each batch.
 * Resolves to { results } where each entry carries the sheet row plus
 * batchId/status/error.
 */
export async function uploadBatches({ userName, password, batches, onProgress, onResult }) {
    const client = createClient();
    let { csrfToken, authToken } = await authenticate(client, userName, password);

    const results = [];
    let created = 0;
    let failed = 0;

    for (const batch of batches) {
        let attempt = 0;
        let done = false;

        while (!done) {
            try {
                const outcome = await createBatch(client, batch, csrfToken, authToken);
                const row = { ...batch, ...outcome };
                results.push(row);
                if (onResult) await onResult(row);
                created++;
                done = true;
            } catch (err) {
                attempt++;

                if (err.httpStatus === 412 && attempt === 1) {
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch (reAuthError) {
                        const failedRow = { ...batch, batchId: '', status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}`, call: reAuthError.call || describeCall({ endpoint: USER_SERVICE_URL + '/api/user/v1/login', responseBody: reAuthError.message }), attempts: attempt };
                        results.push(failedRow);
                        if (onResult) await onResult(failedRow);
                        failed++;
                        done = true;
                        break;
                    }
                }

                if (err.httpStatus === 429 && attempt <= 3) {
                    await delay(Math.min(1000 * 2 ** attempt, 30000));
                    continue;
                }

                if (isServiceDown(err)) {
                    err.serviceDown = true;
                    throw err;
                }

                const failedRow = { ...batch, batchId: '', status: 'FAILED', error: err.message, call: err.call || null, attempts: attempt };
                results.push(failedRow);
                if (onResult) await onResult(failedRow);
                failed++;
                done = true;
            }
        }

        if (onProgress) {
            onProgress({ processed: results.length, total: batches.length, created, failed });
        }

        await delay(100); // same pacing the existing script uses
    }

    return { results, created, failed };
}
