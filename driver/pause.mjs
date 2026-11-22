#!/usr/bin/env node
// The ONE pause command (8.8, 9.6). A pause that is Michael's exists only with his Telegram user id and the id of the
// message it came from (Godspeed's bot passes both); any other pause is a program's, expires at its maximum and escalates.
//   pause set <target> "<why>" --telegram-user <id> --message-id <id> [--until <iso>]
//   pause clear <target>
// target: hold | PAUSE:<project> | STOP:<project> | parked:<folder>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./facts.mjs";

export const FILE = (e = process.env) => path.join(e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver", "pauses.json");
export const allowedUsers = (e = process.env) => String(e.FD_ALLOWED_USERS || readEnvFile(e.TG_ENV || "").TELEGRAM_ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean);
const read = f => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(d) ? d : []; } catch { return []; } };
export function setPause(file, rec, allowed, now = new Date()) {
  if (!rec.target || !rec.why) throw new Error("a pause needs a target and a reason");
  if (!rec.telegramUser || !allowed.includes(String(rec.telegramUser))) throw new Error("only the owner's own Telegram user id can pause the factory");
  if (!rec.messageId) throw new Error("a pause needs the id of the message it came from");
  const list = read(file).filter(r => r.target !== rec.target);
  list.push({ target: rec.target, why: rec.why, telegramUser: String(rec.telegramUser), messageId: String(rec.messageId), until: rec.until || null, at: now.toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
}
export function clearPause(file, target) { fs.writeFileSync(file, JSON.stringify(read(file).filter(r => r.target !== target), null, 2) + "\n"); }
// The command, also run by `godspeed-forge driver pause ...` once the settings are in the environment.
export function pauseCommand(a, e = process.env) {
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a[0] === "set") setPause(FILE(e), { target: a[1], why: a[2], telegramUser: opt("--telegram-user"), messageId: opt("--message-id"), until: opt("--until") }, allowedUsers(e));
  else if (a[0] === "clear") clearPause(FILE(e), a[1]);
  else throw new Error("usage: pause set <target> <why> --telegram-user <id> --message-id <id> [--until <iso>] | clear <target>");
  return "ok";
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(pauseCommand(process.argv.slice(2))); } catch (e) { console.error("pause failed:", e.message); process.exit(1); }
}
