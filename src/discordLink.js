'use strict';
/**
 * Discord OAuth2 ("identify" scope) used to link a dashboard account to a Discord user.
 * The tokens let us notice when a user revokes the authorization in Discord.
 */
const API = 'https://discord.com/api/v10';
const TIMEOUT = 10000;

function authorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL('https://discord.com/oauth2/authorize');
  u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state, prompt: 'consent' }).toString();
  return u.href;
}

async function post(path, form, fetchImpl) {
  return fetchImpl(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT) });
}
const tokenSet = (j) => ({ accessToken: j.access_token, refreshToken: j.refresh_token, tokenExpiresAt: Date.now() + Number(j.expires_in || 0) * 1000 });

async function me(accessToken, fetchImpl) {
  return fetchImpl(`${API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT) });
}
const identity = (j) => ({ id: String(j.id), username: String(j.global_name || j.username || j.id) });

/** Exchanges the OAuth code for tokens and reads the Discord identity. */
async function completeLink({ clientId, clientSecret, redirectUri, code }, { fetchImpl = globalThis.fetch } = {}) {
  const res = await post('/oauth2/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl);
  if (!res.ok) throw new Error('Discord did not accept the sign-in. Please try again.');
  const tokens = tokenSet(await res.json());
  const who = await me(tokens.accessToken, fetchImpl);
  if (!who.ok) throw new Error('Could not read your Discord profile. Please try again.');
  return { ...identity(await who.json()), ...tokens };
}

/**
 * Checks that the user still authorizes the app.
 * Returns { status: 'ok' | 'revoked' | 'error', patch? }.  Network problems are 'error' and never unlink anybody.
 */
async function checkLink({ clientId, clientSecret }, link, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    if (link.accessToken && link.tokenExpiresAt && link.tokenExpiresAt > now + 60000) {
      const r = await me(link.accessToken, fetchImpl);
      if (r.ok) { const id = identity(await r.json()); return { status: 'ok', patch: id.username !== link.username ? { username: id.username } : {} }; }
      if (r.status !== 401) return { status: 'error' };
    }
    if (!link.refreshToken) return { status: 'revoked' };
    const rr = await post('/oauth2/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: link.refreshToken }, fetchImpl);
    if (rr.status === 400 || rr.status === 401) return { status: 'revoked' };
    if (!rr.ok) return { status: 'error' };
    const tokens = tokenSet(await rr.json());
    const r2 = await me(tokens.accessToken, fetchImpl);
    if (r2.status === 401) return { status: 'revoked' };
    if (!r2.ok) return { status: 'error' };
    return { status: 'ok', patch: { ...tokens, username: identity(await r2.json()).username } };
  } catch { return { status: 'error' }; }
}

module.exports = { authorizeUrl, completeLink, checkLink };
