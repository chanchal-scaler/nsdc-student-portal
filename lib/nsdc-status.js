/**
 * Whether a failure means Skill India (NSDC) itself is unreachable or broken,
 * rather than the row being wrong. Worth telling apart: a sheet with a bad row
 * needs fixing, a service that is down needs waiting, and the two look the same
 * in a raw error message.
 */
export function isServiceDown(error) {
    if (!error) return false;

    const status = error.httpStatus;
    if (status === 502 || status === 503 || status === 504) return true;
    if (status >= 500) return true;

    const text = String(error.message || error);
    return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|network|timeout|failed, reason/i.test(text);
}

export const SERVICE_DOWN_MESSAGE =
    'Skill India (NSDC) is not responding. Nothing further was sent. Try again once it is back — re-uploading the same sheet picks up where this left off.';
