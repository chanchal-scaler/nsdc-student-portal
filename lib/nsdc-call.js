/**
 * What one failed NSDC request was, in the shape the failures page needs:
 * which endpoint, what was sent, what came back.
 *
 * Carried on the thrown Error as `err.call` and then onto the failure row, so a
 * run does not have to be watched to find out why a row was refused.
 */
export function describeCall({ endpoint, method = 'POST', payload, status, responseBody }) {
    return {
        endpoint,
        method,
        requestPayload: payload === undefined ? null : payload,
        httpStatus: typeof status === 'number' ? status : null,
        // Trimmed here as well as in the database: an HTML error page is not
        // worth carrying around in memory for the length of a run
        responseBody: responseBody === undefined || responseBody === null
            ? null
            : String(responseBody).slice(0, 8000)
    };
}

/** Attaches the description to an error and hands the error back. */
export function withCall(error, call) {
    error.call = call;
    return error;
}
