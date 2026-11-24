// The questions step: settles each new question in the factory's "Owner decisions needed" issue (one per project)
// and relays the owner's answers back as an "Owner decision" comment. It used to run as its own timer every 15
// minutes (factory-owner-questions.timer); now it is a step of the driver, every 5 minutes so a page escalates on
// time. The logic is factory-owner-questions.mjs (since 2026-11-24: decided at once under the owner's standing
// instruction, paged with receipts only when the answer would spend money, publish or delete people's data, or
// handed to the driver's decide helper; see the top of that file).
//
// Stuck, which only someone acting on the server can put right, is a halt, never a message to the owner:
//   unreadable    a project's question list could not be read for a whole day
//   missing-issue items wait for the owner but the "Owner decisions needed" issue is gone
// The step reports a halt on every run while it holds; it ends when the condition does.
import path from "node:path";
import { run as askRun, genericProject } from "./questions/factory-owner-questions.mjs";
import { readEnvFile } from "../facts.mjs";
import { trustedFor } from "./trust.mjs";

export const STEP = { name: "questions", everyMinutes: 5, maxMinutes: 15, inRound: false };
export const SETTINGS = [
  { key: "server.factory_user", required: true, meaning: "the account whose GitHub login (the builder App) reads the issues and posts the decisions and the owner's answers" },
  { key: "server.factory_home", required: true, meaning: "that account's home folder (where its GitHub login lives)" },
  { key: "server.questions_dir", required: false, default: "<server.state_dir>/questions", meaning: "the folder of this step's state: what was decided, paged and relayed, the replies cursor, the answered-elsewhere list" },
  { key: "steps.questions.state_dir", required: false, default: "server.questions_dir", meaning: "overrides server.questions_dir for this step" },
  { key: "steps.questions.godspeed_dir", required: true, meaning: "the Godspeed folder (its model.mjs words the messages of a page)" },
  { key: "steps.questions.hermes_home", required: true, meaning: "the folder of the chat program whose message store holds the owner's Telegram replies" },
  { key: "owner.name", required: false, default: "the person who owns it", meaning: "how the owner is named in the prompts and in a decision's heading" },
  { key: "owner.email", required: false, default: "none: a page has no email step", meaning: "the owner's email address, for a page that got no answer on Telegram after 10 minutes" },
  { key: "notices.email.inbox", required: false, default: "none", meaning: "the AgentMail inbox the page's email is sent from; its keys are AGENTMAIL_SEND_KEY and AGENTMAIL_READ_KEY in keys.env_file (his reply is read with the second)" },
  { key: "notices.email.api", required: false, default: "https://api.agentmail.to", meaning: "the mail service's address" },
  { key: "steps.questions.urgent_repo", required: false, default: "notices.watch_issues_repo", meaning: "the repository where a page opens an issue for the owner after 10 minutes (none: no urgent issue)" },
  { key: "steps.questions.urgent_label", required: false, default: "<owner.name>-urgent", meaning: "that issue's label, which a hook of the owner's assistant shows at the top of every chat" },
  { key: "notices.telegram_env_file", required: false, default: "none", meaning: "the chat bot's env file: a page is sent with it, so the owner's reply lands where it is read" },
  { key: "notices.telegram_machine_env_file", required: false, default: "none", meaning: "the machine bot's env file, used for a page only when the chat bot has none" },
];

const get = (o, dotted) => dotted.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
// "Alex" -> "alex-urgent"; no name -> "owner-urgent"
export const urgentLabelFor = name => {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${!slug || slug === "the-owner" || slug === "the-person-who-owns-it" ? "owner" : slug}-urgent`;
};

export function envFor(ctx) {
  const s = ctx.settings;
  const need = key => { const v = get(s, key); if (v === undefined || v === null || v === "") throw new Error(`the setting ${key} is missing`); return v; };
  const main = ctx.main || (ctx.projects || [])[0];
  if (!main) throw new Error("no project to ask about");
  const all = (ctx.projects && ctx.projects.length ? ctx.projects : [main]);
  const ordered = [main, ...all.filter(p => p !== main && p.repository !== main.repository)];
  const dir = get(s, "steps.questions.state_dir") || get(s, "server.questions_dir") || path.posix.join(need("server.state_dir"), "questions");
  const godspeedDir = need("steps.questions.godspeed_dir");
  const test = Object.fromEntries(Object.entries(ctx.env || {}).filter(([k]) => /^OQ_(ISSUES_FILE|MODEL_CMD|MESSAGES_FILE|COMMENTS_FILE|POST_CMD|LABEL_CMD)$/.test(k)));
  const stateDir = get(s, "server.state_dir");
  return {
    // trusted: who may decide a question on GitHub (the owner and the project's own Apps, as the trust step has it), so a
    // decision of theirs ends a page and keeps one from starting
    PROJECTS: ordered.map(p => ({ ...genericProject(p.repository), ...(p.questions || {}), repo: p.repository, main: p === main || p.repository === main.repository, trusted: trustedFor(s, p) })),
    MAIN_REPO: main.repository,
    FORGE_USER: need("server.factory_user"), FORGE_HOME: need("server.factory_home"),
    GODSPEED_DIR: godspeedDir, HERMES_HOME: need("steps.questions.hermes_home"),
    STATE: path.posix.join(dir, "state.json"),
    JOURNAL: stateDir ? path.posix.join(stateDir, "journal.jsonl") : "",
    OWNER_NAME: get(s, "owner.name") || undefined,
    OWNER_LOGIN: get(s, "owner.github_login") || "",
    OWNER_EMAIL: get(s, "owner.email") || "",
    MAIL_INBOX: get(s, "notices.email.inbox") || "",
    MAIL_API: get(s, "notices.email.api") || "",
    KEYS_FILE: get(s, "keys.env_file") || (ctx.settingsDir ? path.posix.join(ctx.settingsDir, "keys.env") : ""),
    TG_ENV: get(s, "notices.telegram_env_file") || "",
    // his replies count only from his own Telegram account: the settings' ids, else the chat bot's allowed users
    OWNER_TELEGRAM_IDS: (Array.isArray(get(s, "owner.telegram_user_ids")) && get(s, "owner.telegram_user_ids").length ? get(s, "owner.telegram_user_ids")
      : String(readEnvFile(get(s, "notices.telegram_env_file") || "").TELEGRAM_ALLOWED_USERS || "").split(",")).map(x => String(x).trim()).filter(Boolean),
    NOTICES_FILE: get(s, "notices.godspeed_notices_file") || path.posix.join(godspeedDir, ".godspeed", "notices.json"),
    TG_MACHINE_ENV: get(s, "notices.telegram_machine_env_file") || "",
    URGENT_REPO: get(s, "steps.questions.urgent_repo") || get(s, "notices.watch_issues_repo") || get(s, "notices.watch_repo") || "",
    URGENT_LABEL: get(s, "steps.questions.urgent_label") || urgentLabelFor(get(s, "owner.name")),
    DRY: !!ctx.dry,
    ...test,
  };
}

// The command an acting AI run with root uses after fixing what the halt says: the step looks again, and
// the halt is gone once the condition is.
export const clearCommand = ctx => `node ${get(ctx.settings, "server.driver_dir") || "<driver dir>"}/driver.mjs --step questions --settings-dir ${ctx.settingsDir || "<settings dir>"}`;

// -> { ok, summary, halt?, halts?, error? }
export async function run(ctx) {
  let env;
  try { env = envFor(ctx); } catch (e) { return { ok: false, summary: "not set up", error: e.message }; }
  const log = ctx.log || (() => {});
  let r;
  try { r = await askRun(env, ctx.nowMs ? ctx.nowMs() : Date.now(), log, ctx.questionDeps || {}); }
  catch (e) { return { ok: false, summary: "the run failed", error: String(e.message).slice(0, 300) }; }
  const halts = (r.halts || []).map(h => ({ ...h, clear: clearCommand(ctx) }));
  const parts = [
    r.decided.length ? `decided at once: ${r.decided.length}` : "",
    r.paged.length ? `paged: ${r.paged.join("; ")}` : "",
    r.routed.length ? `to the decide helper: ${r.routed.length}` : "",
    r.sent.length ? `relayed: ${r.sent.join("; ")}` : "",
    (r.pageNotes || []).length ? `page sends: ${r.pageNotes.join(", ")}` : "",
  ].filter(Boolean);
  const summary = `${parts.join("; ") || "nothing new"}${halts.length ? `; halted: ${halts.map(h => h.key).join(", ")}` : ""}`;
  return { ok: !!r.ok, summary, ...(halts.length ? { halt: halts[0], halts } : {}), ...(r.ok ? {} : { error: "a project's question list could not be read" }) };
}
