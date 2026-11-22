// Turns the driver's settings into what the moved release helpers read (config.mjs and the AUTO_STAGE_* /
// AUTO_PLAN_* / KEEP_MAIN_GREEN_* names their loadConfig already understands). One place, so the three step
// modules only say which of these they need.
//
// Where a value lives (the same key names settings.mjs uses):
//   main.*       the main project's file (ctx.main): its repository, its checkout, its apps
//   releases.*   the `releases` block of that file
//   other keys   the driver's settings (ctx.settings): owner, server, keys, notices, steps.<name>
// A value the settings collector already resolved (a default included) is in ctx.env under the name the
// core gives it; that is read first, and the raw file is the fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, cfg } from "./config.mjs";

const dig = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

// Every key the release helpers read: its settings key, the env name the core resolves it into (when it
// does), a static default, an alternative key to fall back to, and what it means.
export const KEYS = {
  repository: { key: "main.repository", env: "FD_REPO", meaning: "owner/repository of the product the factory builds and the driver releases" },
  checkout: { key: "main.checkout", env: "FD_SOURCE_CHECKOUT", meaning: "the product's checkout on this server: the planner may read it, and the factory's STOP file lives under it" },
  recordsCheckout: { key: "releases.records_checkout", env: "FD_DEV_CHECKOUT", meaning: "this server's checkout of the records repository (release plans, tickets, staging records)" },
  kitBootstrap: { key: "releases.kit_bootstrap_repo", meaning: "owner/repository of the bootstrap installer the product's stage file names" },
  server: { key: "releases.server", meaning: "the ssh name of the machine the product is installed on first (or the name of this machine when it is that one)" },
  routeSuffix: { key: "releases.server_route_suffix", dflt: "", meaning: "appended to the server's name for a second route to it, for example -ts; empty tries one route" },
  godspeedDir: { key: "releases.godspeed_dir", alt: "ai.act_brain_dir", env: "FD_ACT_BRAIN", meaning: "the product's folder on that machine; default: the folder the acting runs work in (ai.act_brain_dir)" },
  stagingDir: { key: "releases.staging_dir", dflt: "", meaning: "where candidates and the pin live on that machine; default <godspeed_dir>-staging" },
  healthUrl: { key: "releases.health_url", env: "FD_HEALTH_URL", dflt: "http://127.0.0.1:47831/health", meaning: "the product's health address as that machine reads it" },
  scenariosWorkflow: { key: "releases.scenarios_workflow", env: "FD_SCENARIOS_WORKFLOW", dflt: "scenarios.yml", meaning: "the product's proving workflow file" },
  timezone: { key: "releases.timezone", dflt: "UTC", meaning: "the time zone the records' days are counted in" },
  gitEmail: { key: "releases.git_email", dflt: "release-step@users.noreply.github.com", meaning: "the e-mail the release step's record commits carry" },
  serverIsThisMachine: { key: "releases.server_is_this_machine", dflt: false, meaning: "true when the machine the product is installed on first is this one: its commands then run locally, not over ssh" },
  notifyCommand: { key: "releases.notify_command", dflt: "", meaning: "optional program and fixed arguments that take --summary --status --act; empty uses Godspeed's notice queue" },
  builderApp: { key: "main.apps.builder", env: "FD_BUILDER_APP", meaning: "the builder App's login" },
  releaseApp: { key: "main.apps.release", env: "FD_RELEASE_APP", meaning: "the release App's login" },
  ownerName: { key: "server.name_in_messages", env: "FD_OWNER_NAME", dflt: "the owner", meaning: "how messages name the owner; also the name a person's scope amendment is approved by" },
  ownerLogin: { key: "owner.github_login", env: "FD_OWNER_LOGIN", meaning: "the owner's GitHub login: whose issues the planner trusts" },
  tokenScript: { key: "keys.token_script", env: "FD_TOKEN_SCRIPT", meaning: "the script that mints a GitHub App token: node <script> <role> <owner/repo> --permissions <p>" },
  keysEnv: { key: "keys.env_file", env: "FD_KEYS_FILE", dflt: "", meaning: "the file of KEY=value lines with the Apps' keys; read into the helpers' environment, never printed" },
  noticesFile: { key: "notices.godspeed_notices_file", env: "FD_NOTICES_FILE", dflt: "", meaning: "Godspeed's notice queue (notices.json); default <godspeed_dir>/.godspeed/notices.json" },
  factoryUser: { key: "server.factory_user", env: "FORGE_USER", meaning: "the factory's account, as which the planning AI and the issue writes run" },
  factoryHome: { key: "server.factory_home", env: "FD_FORGE_HOME", dflt: "", meaning: "that account's home folder (default /home/<factory_user>)" },
  archonConfig: { key: "server.archon_config", env: "FD_ARCHON_CONFIG", dflt: "", meaning: "the factory's model settings file, which names the strongest tier the planner uses (default <factory_home>/.archon/config.yaml)" },
  stateRoot: { key: "server.state_dir", env: "FD_STATE_DIR", dflt: "/var/lib/godspeed/forge/driver", meaning: "the driver's state folder; each step's own folder is under it by default" },
};

// The raw or resolved value of a key. `name` is an entry of KEYS, or a plain settings key.
export function read(ctx, nameOrKey) {
  const k = KEYS[nameOrKey];
  const key = k ? k.key : nameOrKey;
  const env = ctx.env && typeof ctx.env === "object" ? ctx.env : {};
  if (k && k.env && !empty(env[k.env])) return env[k.env];
  if (key.startsWith("main.")) return ctx.main ? dig(ctx.main, key.slice(5)) : undefined;
  if (key.startsWith("releases.")) return ctx.main && ctx.main.releases ? dig(ctx.main.releases, key.slice(9)) : undefined;
  return dig(ctx.settings, key);
}

// The entries of a step's SETTINGS for some of these keys. None is marked required for the settings collector:
// the collector reads every step module, enabled or not, and would refuse a server that has not set up releases at
// all. A step that lacks a value refuses to run instead, naming the key (prepare() -> refuseMissing), which the
// runner shows as that step's health entry.
export const settingsFor = (names, requiredNames = names) =>
  names.map((n) => {
    const k = KEYS[n];
    return { key: k.key, required: false, default: "dflt" in k ? k.dflt : undefined, meaning: k.meaning };
  });

// A step's own state folder: its setting, else under the driver's state folder like the core's own steps.
export function stepStateDir(ctx, step) {
  const own = dig(ctx.settings, `steps.${step}.state_dir`);
  if (!empty(own)) return own;
  const env = ctx.env && typeof ctx.env === "object" ? ctx.env : {};
  const root = env.FD_STATE_DIR || dig(ctx.settings, "server.state_dir") || KEYS.stateRoot.dflt;
  return `${root}/steps/${step}`;
}

export const stepValue = (ctx, step, name, dflt) => {
  const got = dig(ctx.settings, `steps.${step}.${name}`);
  return empty(got) ? dflt : got;
};

// A KEY=value file read into an object; comments and blank lines are skipped. Values are never logged.
// A file that is not there is no keys (the helper that needs one says so); one that cannot be read is an error.
export function readEnvFile(file) {
  const out = {};
  if (!file) return out;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw new Error(`The keys file named in keys.env_file (${file}) cannot be read (${e.code || e.message}).`);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const login = (v) => String(v && typeof v === "object" ? v.login || v.name || "" : v || "").replace(/\[bot\]$/, "");

// Configures the release helpers from the settings and returns { env, missing } where `missing` names every
// required key that is empty (the caller refuses to run when it is not empty).
export function prepare(ctx, { need = [], stepName, withKeysEnv = false } = {}) {
  const missing = [];
  const v = (name) => {
    const k = KEYS[name];
    let got = read(ctx, name);
    if (empty(got) && k.alt) got = dig(ctx.settings, k.alt);
    if (empty(got)) {
      if ("dflt" in k) return k.dflt;
      if (need.includes(name)) missing.push(k.key);
      return undefined;
    }
    return got;
  };
  const godspeedDir = v("godspeedDir");
  const builder = login(v("builderApp"));
  const release = login(v("releaseApp"));
  const apps = [builder, release].filter(Boolean);
  configure({
    productRepo: v("repository"),
    recordsRoot: v("recordsCheckout"),
    kitBootstrapRepo: v("kitBootstrap"),
    server: v("server"),
    serverRouteSuffix: v("routeSuffix"),
    godspeedOnServer: godspeedDir,
    stagingOnServer: v("stagingDir") || (godspeedDir ? `${godspeedDir}-staging` : undefined),
    healthUrl: v("healthUrl"),
    scenariosWorkflow: v("scenariosWorkflow"),
    timezone: v("timezone"),
    gitEmail: v("gitEmail"),
    stagingOnServerItself: v("serverIsThisMachine") === true || v("serverIsThisMachine") === "true",
    notifyCommand: v("notifyCommand"),
    noticesFile: v("noticesFile") || (godspeedDir ? `${godspeedDir}/.godspeed/notices.json` : undefined),
    ownerName: v("ownerName"),
    ownerLogin: v("ownerLogin"),
    tokenScript: v("tokenScript"),
    deliveryAuthors: apps,
    trustedBots: apps.map((a) => `${a}[bot]`),
    releaseApp: release ? `${release}[bot]` : undefined,
    standingDecision: stepName ? dig(ctx.settings, `steps.${stepName}.standing_decision`) || undefined : undefined,
  });
  const keys = withKeysEnv ? readEnvFile(v("keysEnv")) : {};
  const env = { HOME: os.homedir(), LANG: "C.UTF-8", ...process.env, ...(ctx.env && typeof ctx.env === "object" ? ctx.env : {}), ...keys };
  return { env, missing: [...new Set(missing)] };
}

export const refuseMissing = (step, missing) => ({
  ok: false,
  summary: `${step}: not run, settings missing`,
  error: `The ${step} step has no value for ${missing.join(", ")}; set them in the settings and it runs.`,
});

export { cfg, path };
