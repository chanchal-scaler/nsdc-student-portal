import crypto from 'crypto';

// scrypt rather than a plain hash: the portal's passwords are handed out by us
// and typed by people, so they are short enough that a fast hash would be worth
// attacking if the database ever leaked.
const KEY_LENGTH = 64;
const SCRYPT_COST = 16384; // N; the default work factor, ~16MB of memory per hash

/**
 * Hashes a password for storage. The salt and the cost are kept in the same
 * string so an existing row can still be verified after these numbers change.
 */
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_COST });
    return `scrypt$${SCRYPT_COST}$${salt}$${derived.toString('hex')}`;
}

/**
 * True when the password matches the stored hash. Compared in constant time, so
 * a wrong password cannot be narrowed down by how long the check took.
 */
export function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;

    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

    const cost = parseInt(parts[1], 10);
    const salt = parts[2];
    if (!Number.isInteger(cost) || !salt) return false;

    let expected;
    try {
        expected = Buffer.from(parts[3], 'hex');
    } catch {
        return false;
    }
    if (expected.length !== KEY_LENGTH) return false;

    let derived;
    try {
        derived = crypto.scryptSync(password, salt, KEY_LENGTH, { N: cost });
    } catch {
        return false;
    }

    return crypto.timingSafeEqual(derived, expected);
}
