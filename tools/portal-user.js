/**
 * Manages the portal's logins.
 *
 * One shared login could not say whose upload failed. A login per person can,
 * and the failures page names them — so the people who upload are listed here.
 * Google says who somebody is; this list says whether they may come in.
 *
 *   node tools/portal-user.js list
 *   node tools/portal-user.js add priya@scaler.com
 *   node tools/portal-user.js add priya@scaler.com "Priya, ops"
 *   node tools/portal-user.js off priya@scaler.com
 *
 * Needs DATABASE_URL, the same one the portal uses.
 */
import { initSchema, savePortalUser, listPortalUsers, deactivatePortalUser, isEnabled } from '../lib/db.js';

const [command, email, label] = process.argv.slice(2);

function usage() {
    console.log(`Usage:
  node tools/portal-user.js list
  node tools/portal-user.js add <email> [label]
  node tools/portal-user.js off <email>

Set DATABASE_URL first, e.g.
  set -a; . ./.env; set +a; node tools/portal-user.js list`);
}

if (!isEnabled) {
    console.error('DATABASE_URL is not set, so there is nowhere to keep logins.');
    process.exit(1);
}

await initSchema();

if (command === 'list') {
    const users = await listPortalUsers();
    if (users.length === 0) {
        console.log('No logins yet. Nobody can sign in until an address is added here.');
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
    await savePortalUser({ email, label: label || null });
    console.log(`${email.trim().toLowerCase()} can now sign in with Google.`);
    console.log('It has to be the address Google itself returns, not an alias.');
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
