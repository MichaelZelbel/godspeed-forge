// The one place the moved release helpers (stage, plan, keep-main-green) read what is particular to one
// installation: which product repository, which server, which folders. Nothing here names a person, a
// repository or a server. The step modules call configure() with the values from the driver's settings
// (driver.json plus the main project's `releases` block) before they call anything else; a helper that is
// started as its own process (the freeze, the install on the server, the check of it) gets the same values
// through FORGE_RELEASE_CONFIG, a JSON text, so a child sees exactly what its parent saw.
//
// Modules that need a value read it from `cfg` at the moment they use it (never at import), so a
// configure() call after import still reaches them.
export const cfg = {
  productRepo: "", // owner/repository of the product that is staged: the main project's repository
  kitBootstrapRepo: "", // the repository of the bootstrap installer the product's stage file names
  server: "", // the ssh name of the machine the product is installed on first; also its "-ts" twin is tried
  serverRouteSuffix: "-ts", // appended to `server` for the second route (a VPN name); "" tries only `server`
  godspeedOnServer: "", // the product's folder on that machine
  stagingOnServer: "", // where candidates and the pin live there
  healthUrl: "http://127.0.0.1:47831/health", // the product's health address as the server itself reads it
  scenariosWorkflow: "scenarios.yml", // the product's proving workflow
  publicStage: "beta", // the stage the public gets
  timezone: "UTC", // the day boundary of the records
  recordsRoot: "", // the checkout of the records repository: releases/<id>/plan.md, staging.json, go.json
  tokenScript: "", // the script that mints an App token: node <script> <role> <owner/repo> --permissions <p>
  builderHomeDefault: "", // the builder's home on the server, where its AI sessions are measured; "" when not used
  deliveryAuthors: [], // the logins whose "delivered by" comments count (the builder and release Apps)
  stagingOnServerItself: false, // true when this machine IS the server: run its commands locally, not over ssh
  ownerName: "the owner", // how a message names the owner; also the name a person's scope amendment is approved by
  gitEmail: "release-step@users.noreply.github.com", // the e-mail the records commits carry
  ownerLogin: "", // the owner's GitHub login: whose issues the planner trusts
  trustedBots: [], // the logins of the builder and release Apps that may also decide, "name[bot]"
  releaseApp: "", // the release App's login "name[bot]": whose merges are the release step's
  standingDecision: "", // the owner's recorded words that start a bug-fix-only release without his yes
  notifyCommand: "", // optional: a program and its fixed arguments that takes --summary --status --act; "" uses the notice queue
  noticesFile: "", // Godspeed's notice queue (notices.json) on the server
};

const listeners = [];
// A module that derives values from cfg registers here, so configure() reaches it.
export function onConfigure(fn) {
  listeners.push(fn);
}

export function configure(values = {}) {
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && k in cfg) cfg[k] = v;
  for (const fn of listeners) fn(cfg);
  return cfg;
}

// A child process reads what its parent gave it.
export function configureFromEnv(env = process.env) {
  if (!env.FORGE_RELEASE_CONFIG) return cfg;
  let values;
  try {
    values = JSON.parse(env.FORGE_RELEASE_CONFIG);
  } catch {
    throw new Error("FORGE_RELEASE_CONFIG is not JSON, so the release helper does not know its settings.");
  }
  return configure(values);
}

export const configText = () => JSON.stringify(cfg);

// A value that must be set for a helper to work; the sentence names the setting.
export function need(key, setting) {
  if (!cfg[key]) throw new Error(`The setting ${setting} is empty, so the release helper does not know ${key}. Set it in the settings and run again.`);
  return cfg[key];
}
