#!/usr/bin/env node
// The ONE pause command (8.8, 9.6). A pause that is Michael's exists only with his Telegram user id and the id of the
// message it came from (Godspeed's bot passes both); any other pause is a program's, expires at its maximum and escalates.
//   node pause.mjs set <target> "<why>" --telegram-user <id> --message-id <id> [--until <iso>]
//   node pause.mjs clear <target>
// target: hold | PAUSE:<project> | STOP:<project> | parked:<folder>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./facts.mjs";

export const FILE = (e = process.env) => path.join(e.FD_STATE_DIR || "/var/lib/godspeed-factory-driver", "pauses.json");
export const allowedUsers = (e = process.env) => String(readEnvFile(e.TG_ENV || "/root/.hermes/.env").TELEGRAM_ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean);
const read = f => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(d) ? d : []; } catch { return []; } };
export function setPause(file, rec, allowed, now = new Date()) {
  if (!rec.target || !rec.why) throw new Error("a pause needs a target and a reason");
  if (!rec.telegramUser || !allowed.includes(String(rec.telegramUser))) throw new Error("only Michael's own Telegram user id can pause the factory");
  if (!rec.messageId) throw new Error("a pause needs the id of the message it came from");
  const list = read(file).filter(r => r.target !== rec.target);
  list.push({ target: rec.target, why: rec.why, telegramUser: String(rec.telegramUser), messageId: String(rec.messageId), until: rec.until || null, at: now.toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
}
export function clearPause(file, target) { fs.writeFileSync(file, JSON.stringify(read(file).filter(r => r.target !== target), null, 2) + "\n"); }
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const a = process.argv, opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
    if (a[2] === "set") setPause(FILE(), { target: a[3], why: a[4], telegramUser: opt("--telegram-user"), messageId: opt("--message-id"), until: opt("--until") }, allowedUsers());
    else if (a[2] === "clear") clearPause(FILE(), a[3]);
    else throw new Error("usage: pause.mjs set <target> <why> --telegram-user <id> --message-id <id> [--until <iso>] | clear <target>");
    console.log("ok");
  } catch (e) { console.error("pause failed:", e.message); process.exit(1); }
}
