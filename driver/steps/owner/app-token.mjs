// A GitHub App installation token for one repository, made from the App details setup saved
// (<credentials folder>/<role>-app.json: { id, pem, slug, ... }, see lib/github-apps.mjs): a JWT signed with
// the App's own key, the App's installation on that repository, and a token for that installation.
//
// The token lives only in this process's memory, and is used again until five minutes before GitHub says it
// expires. It is never written to a file, a log, a message or an error: every error here names what failed,
// never a value.
//
// This lives beside the driver's steps because the driver is installed into a folder of its own, without the
// add-on's lib/; lib/app-token.mjs is the add-on's door to the same code.
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const ROLES = Object.freeze(["builder", "release"]);
export const DEFAULT_API = "https://api.github.com";
const EARLY_MS = 5 * 60 * 1000;
const tokens = new Map();
const installations = new Map();

// reason: 'role' | 'repository' | 'missing' (no saved details) | 'damaged' | 'not-installed' | 'key-rejected'
// | 'refused' | 'unreachable' | 'github'
export class AppTokenError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "AppTokenError";
    this.reason = reason;
  }
}

const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");

// The token an App signs with its own key to speak as itself. iat is a minute back because GitHub refuses a
// token issued after its own clock, and exp stays under GitHub's ten-minute limit.
export function appJwt(details, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const data = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(details.id) })}`;
  return `${data}.${sign("sha256", Buffer.from(data), details.pem).toString("base64url")}`;
}

export async function readAppDetails(credentialDirectory, role) {
  const file = path.join(credentialDirectory, `${role}-app.json`);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw new AppTokenError("missing", `This server holds no details of the ${role} App.`);
    throw new AppTokenError("damaged", `The saved details of the ${role} App cannot be read.`);
  }
  let details;
  try { details = JSON.parse(text); } catch { details = null; }
  if (!details || typeof details !== "object" || !details.id || typeof details.pem !== "string" || !details.pem.includes("PRIVATE KEY")) {
    throw new AppTokenError("damaged", `The saved details of the ${role} App are damaged.`);
  }
  return details;
}

const splitRepository = repository => {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(repository || ""));
  if (!m) throw new AppTokenError("repository", "The repository is not in the form owner/repository.");
  return [m[1], m[2]];
};

async function ask(fetchImpl, url, init, what) {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new AppTokenError("unreachable", `GitHub could not be reached to ${what}.`);
  }
}

// -> the token (a string). Throws AppTokenError.
export async function mintAppToken({ credentialDirectory, repository, role, api, fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!ROLES.includes(role)) throw new AppTokenError("role", "The App role is builder or release.");
  const [owner, name] = splitRepository(repository);
  const base = String(api || process.env.FORGE_GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, "");
  const key = `${path.resolve(String(credentialDirectory || ""))}|${base}|${repository}|${role}`;
  const nowMs = typeof now === "function" ? now() : Number(now) || Date.now();
  const held = tokens.get(key);
  if (held && held.expiresAt - EARLY_MS > nowMs) return held.token;
  const details = await readAppDetails(credentialDirectory, role);
  const jwt = appJwt(details, nowMs);
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "godspeed-forge", authorization: `Bearer ${jwt}` };
  let installation = installations.get(key);
  if (!installation) {
    const r = await ask(fetchImpl, `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`, { method: "GET", headers }, `find the ${role} App's installation`);
    if (r.status === 404) throw new AppTokenError("not-installed", `The ${role} App is not installed on ${repository}.`);
    if (r.status === 401) throw new AppTokenError("key-rejected", `GitHub did not accept the ${role} App's key.`);
    if (r.status === 403) throw new AppTokenError("refused", `GitHub refused to show the ${role} App's installation.`);
    if (!r.ok) throw new AppTokenError("github", `GitHub answered ${r.status} when asked for the ${role} App's installation.`);
    const body = await r.json().catch(() => null);
    if (!body || !body.id) throw new AppTokenError("github", `GitHub did not say which installation the ${role} App has.`);
    installation = body.id;
    installations.set(key, installation);
  }
  const r = await ask(fetchImpl, `${base}/app/installations/${encodeURIComponent(installation)}/access_tokens`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ repositories: [name] }),
  }, `make a token for the ${role} App`);
  if (r.status === 404) { installations.delete(key); throw new AppTokenError("not-installed", `The ${role} App is not installed on ${repository}.`); }
  if (r.status === 401) throw new AppTokenError("key-rejected", `GitHub did not accept the ${role} App's key.`);
  if (r.status === 403 || r.status === 422) throw new AppTokenError("refused", `GitHub refused a token for the ${role} App.`);
  if (!r.ok) throw new AppTokenError("github", `GitHub answered ${r.status} when asked for a token for the ${role} App.`);
  const body = await r.json().catch(() => null);
  if (!body || typeof body.token !== "string" || !body.token) throw new AppTokenError("github", `GitHub did not hand over a token for the ${role} App.`);
  const expiresAt = Date.parse(body.expires_at);
  tokens.set(key, { token: body.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : nowMs + 55 * 60 * 1000 });
  return body.token;
}

// Forgets every token and installation this process holds (a test starts clean with it).
export function forgetAppTokens() {
  tokens.clear();
  installations.clear();
}
