// Where the Forge keeps what the owner steps and requests did, and the files the chat reads.
//
// In the Forge's private state (root on Linux: /var/lib/godspeed/forge, mode 0700, files 0600):
//   projects/<owner>/<repository>/registration.json         setup's record that the repository is set up
//   projects/<owner>/<repository>/releases/<version>/       one approved release: release.json (the record,
//                                                            which item is which issue, what happened to it),
//                                                            plan.md and tickets/NN-<slug>.md
//   credentials/<owner>/<repository>/<role>-app.json        the App details setup saved (read by app-token.mjs)
//   owner-questions/state.json                               the factory's questions: told, answered, kept back
// In Godspeed's workspace (through the bridge, so the assistant can read them):
//   .godspeed/forge/waiting.json                             what the Forge waits on from the owner
//   .godspeed/forge/projects/<owner>--<repository>.json     the facts a plan is made from, and the status
//
// Nothing here sends anything or reaches GitHub.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const DEFAULT_STATE = "/var/lib/godspeed/forge";
export const WAITING_FILE = ".godspeed/forge/waiting.json";
export const factsFile = repository => `.godspeed/forge/projects/${String(repository).replace("/", "--")}.json`;
export const projectName = repository => String(repository).split("/")[1] || String(repository);

export function forgePaths(state = DEFAULT_STATE) {
  const split = repository => String(repository).split("/");
  const projectDir = repository => path.join(state, "projects", ...split(repository));
  return {
    state,
    projectDir,
    registration: repository => path.join(projectDir(repository), "registration.json"),
    releasesDir: repository => path.join(projectDir(repository), "releases"),
    releaseDir: (repository, version) => path.join(projectDir(repository), "releases", version),
    releaseLock: repository => path.join(projectDir(repository), "releases", ".lock"),
    credentialDir: repository => path.join(state, "credentials", ...split(repository)),
    questionsFile: path.join(state, "owner-questions", "state.json"),
    questionsLock: path.join(state, "owner-questions", ".lock"),
  };
}

export const nowMs = now => (typeof now === "function" ? Number(now()) : now instanceof Date ? now.getTime() : Number.isFinite(Number(now)) && now !== null && now !== undefined ? Number(now) : Date.now());
export const iso = ms => new Date(ms).toISOString();

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// A private save: folders 0700, the file 0600, written whole beside it and renamed into place.
export async function writePrivate(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fsp.writeFile(temporary, text, { mode: 0o600 });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

// One holder at a time for a read-change-write of a record: the steps (every 15 minutes) and the owner's
// requests (any time) both change them. A lock older than staleMs was left by a run that died, and is taken over.
export async function withLock(lockFile, fn, { waitMs = 20000, staleMs = 10 * 60 * 1000 } = {}) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const handle = await fsp.open(lockFile, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const st = await fsp.stat(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) { await fsp.unlink(lockFile).catch(() => {}); continue; }
      } catch { continue; }
      if (Date.now() - start > waitMs) throw new Error("another run holds the record; try again shortly");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.unlink(lockFile).catch(() => {});
  }
}

// ---------------------------------------------------------------- the repositories set up with the Forge
// -> [{ repository, checkout }] for every repository whose setup finished on this server.
export function setUpProjects(state = DEFAULT_STATE) {
  const root = path.join(state, "projects");
  const out = [];
  let owners = [];
  try { owners = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return out; }
  for (const owner of owners) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, owner), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { continue; }
    for (const name of names) {
      const r = readJson(path.join(root, owner, name, "registration.json"));
      if (r && r.completed === true && r.repository === `${owner}/${name}`) out.push({ repository: r.repository, checkout: r.checkout || null });
    }
  }
  return out;
}

const loose = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Which set-up repository the owner's words name: "owner/repository", the repository's name, or that name
// written loosely ("My App" for my-app). -> { repository } | { none: true, known: [names] } | { several: [names] }
export function resolveProject(projects, named, prefer = () => false) {
  const names = projects.map(p => p.repository);
  const words = String(named || "").trim();
  if (!words) {
    if (names.length === 1) return { repository: names[0] };
    const preferred = names.filter(prefer);
    if (preferred.length === 1) return { repository: preferred[0] };
    return names.length ? { several: preferred.length > 1 ? preferred : names } : { none: true, known: [] };
  }
  const exact = names.filter(n => n.toLowerCase() === words.toLowerCase());
  if (exact.length === 1) return { repository: exact[0] };
  const byName = names.filter(n => projectName(n).toLowerCase() === words.toLowerCase());
  if (byName.length === 1) return { repository: byName[0] };
  const byLoose = names.filter(n => loose(projectName(n)) === loose(words) || loose(n) === loose(words));
  if (byLoose.length === 1) return { repository: byLoose[0] };
  const several = byName.length > 1 ? byName : byLoose;
  if (several.length > 1) return { several };
  return { none: true, known: names };
}

// ---------------------------------------------------------------- versions
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export const cleanVersion = v => {
  const m = VERSION.exec(String(v || "").trim());
  return m ? String(v).trim().replace(/^v/, "") : null;
};
// Semantic version order: <0 when a is older than b. A version that cannot be read compares as equal.
export function compareVersions(a, b) {
  const pa = VERSION.exec(String(a || "").trim()), pb = VERSION.exec(String(b || "").trim());
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[4] && !pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const xa = pa[4].split("."), xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- release records
export function releaseRecords(state, repository) {
  const P = forgePaths(state);
  let names = [];
  try { names = fs.readdirSync(P.releasesDir(repository), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  return names.map(v => readJson(path.join(P.releaseDir(repository, v), "release.json"))).filter(r => r && r.version)
    .sort((a, b) => String(a.filedAt || "").localeCompare(String(b.filedAt || "")) || compareVersions(a.version, b.version));
}
export const releaseRecord = (state, repository, version) => readJson(path.join(forgePaths(state).releaseDir(repository, version), "release.json"));
export const saveRelease = (state, record) => writePrivate(path.join(forgePaths(state).releaseDir(record.repository, record.version), "release.json"), record);

// The release the Forge is working on for a repository: the newest approved one not yet public or given up.
// filing: its issues are being filed; building: the factory builds them; checking: frozen, its checks run;
// checked: its checks passed, it is being put up to try; staged: it waits for the owner's go; failed: its checks
// (or its staging copy) failed, and only a go with the owner's reason makes it public.
export const ACTIVE = new Set(["filing", "building", "checking", "checked", "staged", "failed"]);
// Whether this server holds the App details setup saved for a repository (a cheap look, no GitHub).
export const hasAppDetails = (state, repository) => ["builder", "release"].every(role => fs.existsSync(path.join(forgePaths(state).credentialDir(repository), `${role}-app.json`)));
export function activeRelease(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (ACTIVE.has(records[i].state)) return records[i];
    if (records[i].state === "public" || records[i].state === "taken-back") return null;
  }
  return null;
}
// The newest release the Forge made public and has not taken back.
export const publicRelease = records => [...records].reverse().find(r => r.state === "public") || null;

// ---------------------------------------------------------------- the factory's questions
export const emptyQuestions = () => ({ next: 1, questions: [], gone: {} });
export function readQuestions(state) {
  const q = readJson(forgePaths(state).questionsFile, null);
  return q && Array.isArray(q.questions) ? { next: Number(q.next) || 1, questions: q.questions, gone: q.gone || {} } : emptyQuestions();
}
export const saveQuestions = (state, q) => writePrivate(forgePaths(state).questionsFile, q);
export const openQuestions = q => q.questions.filter(x => x.status === "told");

// ---------------------------------------------------------------- the files in Godspeed's workspace
export async function readWorkspaceJson(gs, rel) {
  try {
    const text = await gs.readWorkspaceFile(rel);
    if (text === null || text === undefined || text === "") return null;
    return JSON.parse(typeof text === "string" ? text : String(text));
  } catch {
    return null;
  }
}
export const writeWorkspaceJson = (gs, rel, value) => gs.writeWorkspaceFile(rel, `${JSON.stringify(value, null, 2)}\n`);

// waiting.json, written whole from the records each time: the questions told and not yet answered, and the
// releases put up to try that wait for the owner's go. The chat matches a bare "go" or answer to it.
export async function writeWaiting(gs, state, now = Date.now()) {
  const q = readQuestions(state);
  const items = openQuestions(q).map(x => ({ handle: x.handle, kind: "question", project: x.repository, text: x.text || "" }));
  for (const { repository } of setUpProjects(state)) {
    const staged = releaseRecords(state, repository).filter(r => r.state === "staged");
    const r = staged.at(-1);
    if (r) items.push({ handle: "go", kind: "staged", project: repository, text: `${projectName(repository)} ${r.version} is ready to try${r.staging && r.staging.link ? ` at ${r.staging.link}` : ""}. Reply go to make it public.` });
  }
  const value = { updated: iso(nowMs(now)), items };
  await writeWorkspaceJson(gs, WAITING_FILE, value);
  return value;
}

// Changes the facts file of one repository: read, changed by `change`, written whole.
export async function updateFacts(gs, repository, change) {
  const rel = factsFile(repository);
  const facts = (await readWorkspaceJson(gs, rel)) || { repository, name: projectName(repository) };
  const next = (await change(facts)) || facts;
  await writeWorkspaceJson(gs, rel, next);
  return next;
}

// What the facts file says about a release record: its state for the chat, in the same words "release status" uses.
export function releaseFacts(r) {
  if (!r) return null;
  const items = (r.items || []).map(i => ({ title: i.title, outcome: i.outcome, size: i.size, done: !!i.done, closedWithoutChange: !!i.closedUndone }));
  return {
    version: r.version, state: r.state, summary: r.summary, items,
    ...(r.staging && r.staging.link ? { link: r.staging.link } : {}),
    ...(r.public && r.public.url ? { publicUrl: r.public.url } : {}),
    ...(r.failed && r.failed.sentences ? { failedChecks: r.failed.sentences } : {}),
  };
}
