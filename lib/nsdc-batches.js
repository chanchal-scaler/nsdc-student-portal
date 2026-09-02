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
        size: parseInt(batch.size, 10),
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
    const response = await client(USER_SERVICE_URL + '/api/batch/v1/create', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': authToken
        },
        body: JSON.stringify(buildBatchPayload(batch))
    });

    if (response.ok) {
        const body = await response.json();
        if (!body.batchId) {
            throw new Error('NSDC accepted the batch but returned no batchId');
        }
        // NSDC renames a clashing batch — "Academy Dec25" can come back as
        // "Academy Dec25(2)" — so the returned name is what actually exists.
        return { batchId: body.batchId, batchName: body.batchName || batch.batchName, status: 'CREATED' };
    }

    const errorBody = await response.json().catch(() => ({ message: response.statusText }));
    const error = new Error(errorBody.message || response.statusText);
    error.httpStatus = response.status;
    throw error;
}

/**
 * Creates every batch in the sheet, one at a time, in sheet order.
 *
 * onProgress({ processed, total, created, failed }) is called after each batch.
 * Resolves to { results } where each entry carries the sheet row plus
 * batchId/status/error.
 */
export async function uploadBatches({ userName, password, batches, onProgress }) {
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
                results.push({ ...batch, ...outcome });
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
                        results.push({ ...batch, batchId: '', status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}` });
                        failed++;
                        done = true;
                        break;
                    }
                }

                if (err.httpStatus === 429 && attempt <= 3) {
                    await delay(Math.min(1000 * 2 ** attempt, 30000));
                    continue;
                }

                results.push({ ...batch, batchId: '', status: 'FAILED', error: err.message });
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
