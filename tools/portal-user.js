/**
 * Manages the portal's logins.
 *
 * One shared login could not say whose upload failed. A login per person can,
 * and the failures page names them — so the people who upload get an address
 * and a password each, handed out from here.
 *
 *   node tools/portal-user.js list
 *   node tools/portal-user.js add priya@scaler.com            (password generated)
 *   node tools/portal-user.js add priya@scaler.com "a-password" "Priya, ops"
 *   node tools/portal-user.js off priya@scaler.com
 *
 * Needs DATABASE_URL, the same one the portal uses.
 */
import crypto from 'crypto';
import { hashPassword } from '../lib/passwords.js';
import { initSchema, savePortalUser, listPortalUsers, deactivatePortalUser, isEnabled } from '../lib/db.js';

const [command, email, password, label] = process.argv.slice(2);

function usage() {
    console.log(`Usage:
  node tools/portal-user.js list
  node tools/portal-user.js add <email> [password] [label]
  node tools/portal-user.js off <email>

Set DATABASE_URL first, e.g.
  set -a; . ./.env; set +a; node tools/portal-user.js list`);
}

if (!isEnabled) {
    console.error('DATABASE_URL is not set, so there is nowhere to keep logins.');
    process.exit(1);
}

// A generated password is easier to hand out than to invent, and is stronger
// than one somebody types twice
function generatePassword() {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.randomBytes(16))
        .map(byte => alphabet[byte % alphabet.length])
        .join('');
}

await initSchema();

if (command === 'list') {
    const users = await listPortalUsers();
    if (users.length === 0) {
        console.log('No logins yet. Anyone signing in is using LOGIN_EMAIL from the environment.');
    } else {
        for (const user of users) {
            const last = user.last_login_at
                ? new Date(user.last_login_at).toISOString().slice(0, 16).replace('T', ' ')
                : 'never signed in';
            console.log(`${user.active ? ' ' : 'x'} ${user.email}${user.label ? ` (${user.label})` : ''} — ${last}`);
        }
    }
} else if (command === 'add') {
    if (!email || !email.includes('@')) {
        console.error('Give an email address.');
        usage();
        process.exit(1);
    }
    const chosen = password || generatePassword();
    await savePortalUser({ email, passwordHash: hashPassword(chosen), label: label || null });
    console.log(`Login ready for ${email.trim().toLowerCase()}`);
    console.log(`Password: ${chosen}`);
    console.log('Hand those two over. Only the hash is stored, so this is the one time it can be read.');
} else if (command === 'off') {
    if (!email) {
        console.error('Give an email address.');
        process.exit(1);
    }
    const turnedOff = await deactivatePortalUser(email);
    // Turned off rather than deleted: the failures that login is named on are
    // the record of who did what, and should keep naming somebody
    console.log(turnedOff
        ? `${email} can no longer sign in. Their past uploads still name them.`
        : `No login for ${email}.`);
} else {
    usage();
    process.exit(command ? 1 : 0);
}

process.exit(0);
