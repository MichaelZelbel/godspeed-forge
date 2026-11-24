// Which coding assistant (claude or codex) a project's factory uses, for the one cheap call of the owner-questions
// step. In this order: the step's own setting, the project's settings file ("agent", which setup writes), setup's
// record in the Forge's private state (registration.json "agent"), and else the one signed in on this server, found the
// way setup finds it (lib/agent.mjs: `claude auth status`, then `codex login status`), as the factory's account.
import fs from "node:fs";
import path from "node:path";
import { runAs } from "./run.mjs";
import { forgePaths, readJson } from "./records.mjs";

const dig = (o, key) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const KNOWN = new Set(["claude", "codex"]);
const known = v => (KNOWN.has(String(v || "").toLowerCase()) ? String(v).toLowerCase() : null);
const STATUS = { claude: ["auth", "status"], codex: ["login", "status"] };

// The program of an assistant: the settings' ai.bins.<agent> (a path or a command as a list), else its name on PATH. A
// configured path that is not there is not used: the name on PATH is.
export function agentProgram(settings, agent) {
  let bin = dig(settings, `ai.bins.${agent}`);
  if (typeof bin === "string" && bin.trim().startsWith("[")) { try { bin = JSON.parse(bin); } catch { /* a plain path */ } }
  if (Array.isArray(bin) && bin.length) return bin.map(String);
  if (typeof bin === "string" && bin && (!path.isAbsolute(bin) || fs.existsSync(bin))) return [bin];
  return [agent];
}

const signedIn = new Map();
// The assistant signed in for the factory's account, or null; asked once per process.
export function detectAgent(settings, run = runAs) {
  const key = `${dig(settings, "server.factory_user") || ""}|${JSON.stringify(dig(settings, "ai.bins") || {})}`;
  if (signedIn.has(key)) return signedIn.get(key);
  let found = null;
  for (const agent of ["claude", "codex"]) {
    const [cmd, ...args] = agentProgram(settings, agent);
    const r = run(settings, cmd, [...args, ...STATUS[agent]], { timeoutMs: 30000 });
    if (r && r.status === 0) { found = agent; break; }
  }
  signedIn.set(key, found);
  return found;
}
export const forgetDetectedAgents = () => signedIn.clear();

// -> 'claude' | 'codex' | null
export function projectAgent(settings, project, state, { detect = detectAgent } = {}) {
  return known(dig(settings, "steps.owner-questions.agent"))
    || known(project && project.agent)
    || known((readJson(forgePaths(state).registration(project.repository), {}) || {}).agent)
    || known(detect(settings));
}
