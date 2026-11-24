// How the owner steps reach a project on GitHub: the Forge's private state from the settings, and a token of the
// project's builder or release App from the details setup saved there.
import { mintAppToken, AppTokenError, readAppDetails } from "./app-token.mjs";
import { DEFAULT_STATE, forgePaths, readJson } from "./records.mjs";
import { runAsAsync } from "./run.mjs";

const dig = (o, key) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
export const forgeState = settings => dig(settings, "forge.state_dir") || DEFAULT_STATE;

// A command the Forge's own config names (commands.python, commands.gh), unless the step's own settings name it.
export function forgeCommand(settings, step, name, fallback) {
  const own = dig(settings, `steps.${step}.${name}`);
  if (own) return String(own);
  const config = readJson(dig(settings, "forge.config") || "/etc/godspeed-forge/config.json", null);
  return (config && config.commands && config.commands[name]) || fallback;
}

// ---------------------------------------------------------------- who the factory is on GitHub
// The GitHub identities the factory itself writes as on this server, the only ones whose "Owner decisions needed"
// issue is trusted: the project's builder App (`<slug>[bot]`, from the App details setup saved, or the project's
// settings file), and the login of this server's gh sign-in as the factory's account. Cole Medin's factory runs its
// Archon workflows with the gh command line of the account it runs as, so for a project set up by the Forge (which
// gives the factory no App token) the manager opens that issue as the gh sign-in's login; a factory given the builder
// App's token opens it as the App's bot. -> lowercase logins
export async function factoryLogins(settings, state, project, { gh = forgeCommand(settings, "owner-questions", "gh", "gh"), run = runAsAsync, cached = null } = {}) {
  const logins = new Set();
  let slug = null;
  try { slug = (await readAppDetails(forgePaths(state).credentialDir(project.repository), "builder")).slug; } catch { slug = null; }
  for (const s of [slug, project && project.apps && project.apps.builder]) if (typeof s === "string" && s.trim()) logins.add(`${s.trim().toLowerCase()}[bot]`);
  const r = await run(settings, gh, ["api", "user", "--jq", ".login"], { timeoutMs: 60000, env: { GH_PROMPT_DISABLED: "1" } });
  const login = r && r.status === 0 ? String(r.stdout || "").trim().split("\n").pop().trim() : "";
  if (/^[A-Za-z0-9-]+$/.test(login)) logins.add(login.toLowerCase());
  else if (cached) logins.add(String(cached).toLowerCase()); // gh could not answer this time: the login it gave before
  return { logins, ghLogin: /^[A-Za-z0-9-]+$/.test(login) ? login : cached || null };
}

// ctx.impl.token (a test's stand-in) or the real token; ctx.githubApi and ctx.fetch point a test at a stand-in GitHub.
export function tokenFor(ctx, state, repository, role) {
  if (ctx.impl && ctx.impl.token) return ctx.impl.token(repository, role);
  return mintAppToken({ credentialDirectory: forgePaths(state).credentialDir(repository), repository, role, api: ctx.githubApi, fetch: ctx.fetch });
}

// A project whose App details this server does not hold (or holds damaged) lacks its records: skipped quietly.
export const missingRecords = e => e instanceof AppTokenError && (e.reason === "missing" || e.reason === "damaged");
