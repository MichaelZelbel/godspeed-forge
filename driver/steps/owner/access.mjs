// How the owner steps reach a project on GitHub: the Forge's private state from the settings, and a token of the
// project's builder or release App from the details setup saved there.
import { mintAppToken, AppTokenError } from "./app-token.mjs";
import { DEFAULT_STATE, forgePaths } from "./records.mjs";

const dig = (o, key) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
export const forgeState = settings => dig(settings, "forge.state_dir") || DEFAULT_STATE;

// ctx.impl.token (a test's stand-in) or the real token; ctx.githubApi and ctx.fetch point a test at a stand-in GitHub.
export function tokenFor(ctx, state, repository, role) {
  if (ctx.impl && ctx.impl.token) return ctx.impl.token(repository, role);
  return mintAppToken({ credentialDirectory: forgePaths(state).credentialDir(repository), repository, role, api: ctx.githubApi, fetch: ctx.fetch });
}

// A project whose App details this server does not hold (or holds damaged) lacks its records: skipped quietly.
export const missingRecords = e => e instanceof AppTokenError && (e.reason === "missing" || e.reason === "damaged");
