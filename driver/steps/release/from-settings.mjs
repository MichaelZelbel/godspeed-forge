// Turns the driver's settings into what the moved release helpers read (config.mjs and the AUTO_STAGE_* /
// AUTO_PLAN_* / KEEP_MAIN_GREEN_* names their loadConfig already understands). One place, so the three step
// modules only say which of these they need.
//
// Where a value lives:
//   main.*      the main project's file (ctx.main): its repository, its checkout and its `releases` block
//   other keys  the driver's settings (ctx.settings): owner, server, keys, notices, steps.<name>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure, cfg } from "./config.mjs";

const at = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
export const read = (ctx, key) => (key.startsWith("main.") ? at(ctx.main, key.slice(5)) : at(ctx.settings, key));
const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

// Every key the release helpers can read: [key, required by, default or null, meaning]. A step's SETTINGS
// lists the ones it needs, so the settings collector can refuse a missing required key by name.
export const KEYS = {
  repository: { key: "main.repository", meaning: "owner/repository of the product the factory builds and the driver releases" },
  checkout: { key: "main.checkout", meaning: "the product's checkout on this server, which the planner may read and under which the factory's STOP file lives" },
  recordsCheckout: { key: "main.releases.records_checkout", meaning: "a checkout of the records repository (release plans, tickets, staging records) on this server" },
  kitBootstrap: { key: "main.releases.kit_bootstrap_repo", meaning: "owner/repository of the bootstrap installer the product's stage file names" },
  server: { key: "main.releases.server", meaning: "the ssh name of the machine the product is installed on first (or its own name when this machine is it)" },
  routeSuffix: { key: "main.releases.server_route_suffix", dflt: "", meaning: "appended to the server's name for a second route to it, for example -ts; empty tries one route" },
  godspeedDir: { key: "main.releases.godspeed_dir", meaning: "the product's folder on that machine" },
  stagingDir: { key: "main.releases.staging_dir", meaning: "where candidates and the pin live on that machine; default <godspeed_dir>-staging" },
  healthUrl: { key: "main.releases.health_url", dflt: "http://127.0.0.1:47831/health", meaning: "the product's health address as that machine reads it" },
  scenariosWorkflow: { key: "main.releases.scenarios_workflow", dflt: "scenarios.yml", meaning: "the product's proving workflow file" },
  timezone: { key: "main.releases.timezone", dflt: "UTC", meaning: "the time zone the records' days are counted in" },
  gitEmail: { key: "main.releases.git_email", dflt: "release-step@users.noreply.github.com", meaning: "the e-mail the release step's record commits carry" },
  serverIsThisMachine: { key: "main.releases.server_is_this_machine", dflt: false, meaning: "true when the machine the product is installed on first is this one: its commands then run locally, not over ssh" },
  notifyCommand: { key: "main.releases.notify_command", dflt: "", meaning: "optional program and fixed arguments that take --summary --status --act; empty uses Godspeed's notice queue" },
  appLogins: { key: "main.releases.app_logins", meaning: "{ builder, release }: the logins (without [bot]) of the builder App and the release App" },
  ownerName: { key: "server.name_in_messages", dflt: "the owner", meaning: "how messages name the owner; also the name a person's scope amendment is approved by" },
  ownerLogin: { key: "owner.github_login", meaning: "the owner's GitHub login: whose issues the planner trusts and whose decisions count" },
  tokenScript: { key: "keys.token_script", meaning: "the script that mints a GitHub App token: node <script> <role> <owner/repo> --permissions <p>" },
  keysEnv: { key: "keys.env_file", dflt: "", meaning: "the file of KEY=value lines with the Apps' keys; read into the helpers' environment, never printed" },
  noticesFile: { key: "notices.godspeed_notices_file", dflt: "", meaning: "Godspeed's notice queue (notices.json); default <godspeed_dir>/.godspeed/notices.json" },
};

// The entries of a step's SETTINGS for some of these keys.
export const settingsFor = (names, requiredNames = names) =>
  names.map((n) => ({ key: KEYS[n].key, required: requiredNames.includes(n) && !("dflt" in KEYS[n]), default: "dflt" in KEYS[n] ? KEYS[n].dflt : undefined, meaning: KEYS[n].meaning }));

// A KEY=value file read into an object; comments and blank lines are skipped. Values are never logged.
export function readEnvFile(file) {
  const out = {};
  if (!file) return out;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
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

// Configures the release helpers from the settings and returns { env, missing } where `missing` names every
// required key that is empty (nothing is configured half-way: the caller refuses to run when it is not empty).
export function prepare(ctx, { need = [], stepName, withKeysEnv = false } = {}) {
  const missing = [];
  const v = (name) => {
    const k = KEYS[name];
    const got = read(ctx, k.key);
    if (empty(got)) {
      if ("dflt" in k) return k.dflt;
      if (need.includes(name)) missing.push(k.key);
      return undefined;
    }
    return got;
  };
  const godspeedDir = v("godspeedDir");
  const logins = v("appLogins") || {};
  const apps = [logins.builder, logins.release].filter(Boolean);
  if (need.includes("appLogins") && apps.length < 2) missing.push(KEYS.appLogins.key);
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
    stagingOnServerItself: !!v("serverIsThisMachine"),
    notifyCommand: v("notifyCommand"),
    noticesFile: v("noticesFile") || (godspeedDir ? `${godspeedDir}/.godspeed/notices.json` : undefined),
    ownerName: v("ownerName"),
    ownerLogin: v("ownerLogin"),
    tokenScript: v("tokenScript"),
    deliveryAuthors: apps,
    trustedBots: apps.map((a) => `${a}[bot]`),
    releaseApp: logins.release ? `${logins.release}[bot]` : undefined,
    standingDecision: stepName ? read(ctx, `steps.${stepName}.standing_decision`) || undefined : undefined,
  });
  const keys = withKeysEnv ? readEnvFile(v("keysEnv")) : {};
  const env = { HOME: os.homedir(), LANG: "C.UTF-8", ...process.env, ...(ctx.env && typeof ctx.env === "object" ? ctx.env : {}), ...keys };
  return { env, missing: [...new Set(missing)] };
}

export const stepValue = (ctx, step, name, dflt) => {
  const got = read(ctx, `steps.${step}.${name}`);
  return empty(got) ? dflt : got;
};

export const refuseMissing = (step, missing) => ({
  ok: false,
  summary: `${step}: not run, settings missing`,
  error: `The ${step} step has no value for ${missing.join(", ")}; set them in the settings and it runs.`,
});

export { cfg, path };
