import { OAuth2Client } from 'google-auth-library';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

export const CALLBACK_PATH = '/auth/google/callback';
export const ALLOWED_DOMAIN = (process.env.GOOGLE_HD || 'scaler.com').trim().toLowerCase();
export const isConfigured = Boolean(CLIENT_ID && CLIENT_SECRET && BASE_URL);

function client() {
    return new OAuth2Client({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: BASE_URL + CALLBACK_PATH
    });
}

export function authUrl(state) {
    return client().generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        hd: ALLOWED_DOMAIN,
        prompt: 'select_account'
    });
}

export async function identify(code) {
    const oauth = client();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.id_token) throw new Error('Google returned no identity token');

    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
    const payload = ticket.getPayload() || {};

    return {
        email: String(payload.email || '').trim().toLowerCase(),
        emailVerified: payload.email_verified === true,
        domain: String(payload.hd || '').trim().toLowerCase(),
        name: payload.name || null
    };
}
