/**
 * Manages the portal's logins.
 *
 * One shared login could not say whose upload failed. A login per person can,
 * and the failures page names them — so the people who upload are listed here.
 * Google says who somebody is; this list says whether they may come in.
 *
 *   node tools/portal-user.js list
 *   node tools/portal-user.js add priya@scaler.com --by kavya.gupta@scaler.com
 *   node tools/portal-user.js add priya@scaler.com "Priya, ops" --by kavya.gupta@scaler.com
 *   node tools/portal-user.js off priya@scaler.com --by kavya.gupta@scaler.com
 *
 * Needs DATABASE_URL, the same one the portal uses.
 */
import { initSchema, savePortalUser, listPortalUsers, deactivatePortalUser, findPortalUser, countPortalUsers, saveAuditEvent, isEnabled } from '../lib/db.js';

const args = process.argv.slice(2);
const byIndex = args.indexOf('--by');
const by = byIndex === -1 ? null : args[byIndex + 1];
const [command, email, label] = byIndex === -1 ? args : args.slice(0, byIndex);

function usage() {
    console.log(`Usage:
  node tools/portal-user.js list
  node tools/portal-user.js add <email> [label] --by <your email>
  node tools/portal-user.js off <email> --by <your email>

Set DATABASE_URL first, e.g.
  set -a; . ./.env; set +a; node tools/portal-user.js list`);
}

async function grantedBy() {
    if (!by) {
        console.error('Say who you are with --by <your email>, so the activity page can name them.');
        usage();
        process.exit(1);
    }
    if (await countPortalUsers() > 0 && !await findPortalUser(by)) {
        console.error(`"${by}" cannot sign in to the portal, so it is not a name this change can be recorded against.`);
        process.exit(1);
    }
    return by.trim().toLowerCase();
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
    const actor = await grantedBy();
    await savePortalUser({ email, label: label || null });
    await saveAuditEvent({ actor, action: 'access-granted', detail: email.trim().toLowerCase() });
    console.log(`${email.trim().toLowerCase()} can now sign in with Google.`);
    console.log('It has to be the address Google itself returns, not an alias.');
} else if (command === 'off') {
    if (!email) {
        console.error('Give an email address.');
        process.exit(1);
    }
    const actor = await grantedBy();
    const turnedOff = await deactivatePortalUser(email);
    if (turnedOff) await saveAuditEvent({ actor, action: 'access-revoked', detail: email.trim().toLowerCase() });
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
