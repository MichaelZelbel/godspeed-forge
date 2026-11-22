// The questions step: tells the owner on Telegram about each new question in the factory's "Owner decisions
// needed" issue (one per project), says each once, and relays his answers back as an "Owner decision"
// comment. It used to run as its own timer every 15 minutes (factory-owner-questions.timer); now it is a
// step of the driver. The logic is factory-owner-questions.mjs, moved unchanged apart from where its
// values come from (the settings) and what it does when it is stuck (a halt, see below). The messages, the
// queue, the once-only records and the state folder are the same as before, so nothing is said twice.
//
// Stuck, which only someone acting on the server can put right, is a halt, never a message to the owner:
//   unreadable    a project's question list could not be read for a whole day
//   missing-issue items wait for the owner but the "Owner decisions needed" issue is gone
// The step reports a halt on every run while it holds; it ends when the condition does.
import path from "node:path";
import { run as askRun, genericProject } from "./questions/factory-owner-questions.mjs";

export const STEP = { name: "questions", everyMinutes: 15, maxMinutes: 15, inRound: false };
export const SETTINGS = [
  { key: "server.factory_user", required: true, meaning: "the account whose GitHub login (the builder App) reads the issues and posts the owner's answers" },
  { key: "server.factory_home", required: true, meaning: "that account's home folder (where its GitHub login lives)" },
  { key: "server.questions_dir", required: false, default: "<server.state_dir>/questions", meaning: "the folder of this step's state: what was told, the replies cursor, the queue for the assistant, the answered-elsewhere and to-owner lists" },
  { key: "steps.questions.state_dir", required: false, default: "server.questions_dir", meaning: "overrides server.questions_dir for this step" },
  { key: "steps.questions.godspeed_dir", required: true, meaning: "the Godspeed folder (its model.mjs words the messages; the queue note is written into its notebook)" },
  { key: "steps.questions.hermes_home", required: true, meaning: "the folder of the chat program whose message store holds the owner's Telegram replies" },
  { key: "owner.name", required: false, default: "the person who owns it", meaning: "how the owner is named in the prompts and in the queue note" },
  { key: "steps.questions.to_owner_file", required: false, default: "to-owner.json", meaning: "the file (in the state folder) where the queue worker lists the questions it hands to the owner" },
  { key: "steps.questions.worker_log", required: false, default: "none", meaning: "the decisions file of the assistant's queue worker, shown in the queue note" },
  { key: "notices.godspeed_notices_file", required: false, default: "<steps.questions.godspeed_dir>/.godspeed/notices.json", meaning: "the notice queue the messages go into" },
  { key: "projects[].questions", required: false, default: "plain words naming the repository", meaning: "per project: label, name, product, seat, example (what the model is told the software is, and the seat the example is written from)" },
];

const get = (o, dotted) => dotted.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);

export function envFor(ctx) {
  const s = ctx.settings;
  const need = key => { const v = get(s, key); if (v === undefined || v === null || v === "") throw new Error(`the setting ${key} is missing`); return v; };
  const main = ctx.main || (ctx.projects || [])[0];
  if (!main) throw new Error("no project to ask about");
  const all = (ctx.projects && ctx.projects.length ? ctx.projects : [main]);
  const ordered = [main, ...all.filter(p => p !== main && p.repository !== main.repository)];
  const dir = get(s, "steps.questions.state_dir") || get(s, "server.questions_dir") || path.posix.join(need("server.state_dir"), "questions");
  const godspeedDir = need("steps.questions.godspeed_dir");
  const test = Object.fromEntries(Object.entries(ctx.env || {}).filter(([k]) => /^OQ_(ISSUES_FILE|MODEL_CMD|MESSAGES_FILE|COMMENTS_FILE|POST_CMD)$/.test(k)));
  return {
    PROJECTS: ordered.map(p => ({ ...genericProject(p.repository), ...(p.questions || {}), repo: p.repository, main: p === main || p.repository === main.repository })),
    MAIN_REPO: main.repository,
    FORGE_USER: need("server.factory_user"), FORGE_HOME: need("server.factory_home"),
    GODSPEED_DIR: godspeedDir, HERMES_HOME: need("steps.questions.hermes_home"),
    STATE: path.posix.join(dir, "state.json"),
    NOTICES_FILE: get(s, "notices.godspeed_notices_file") || path.posix.join(godspeedDir, ".godspeed", "notices.json"),
    WORKER_LOG: get(s, "steps.questions.worker_log") || undefined,
    OWNER_NAME: get(s, "owner.name") || undefined,
    TO_OWNER_FILE: get(s, "steps.questions.to_owner_file") || undefined,
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
  try { r = askRun(env, ctx.nowMs ? ctx.nowMs() : Date.now(), log); }
  catch (e) { return { ok: false, summary: "the run failed", error: String(e.message).slice(0, 300) }; }
  const halts = (r.halts || []).map(h => ({ ...h, clear: clearCommand(ctx) }));
  const summary = `${r.sent.length ? `told or relayed: ${r.sent.join("; ")}` : "nothing new"}${halts.length ? `; halted: ${halts.map(h => h.key).join(", ")}` : ""}`;
  return { ok: !!r.ok, summary, ...(halts.length ? { halt: halts[0], halts } : {}), ...(r.ok ? {} : { error: "a project's question list could not be read" }) };
}
