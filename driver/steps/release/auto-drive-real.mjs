// The outside of auto-drive.mjs for real: GitHub through the builder App and git in a bare clone of
// its own, with keep-main-green's mechanics (its revert commit, its branch prefix, its squash merge
// pinned to the head once `required` passes). Nothing here decides anything; auto-drive.mjs does.
import path from "node:path";
import * as R from "./release-api.mjs";
import * as K from "./keep-main-green.mjs";

const MINUTE = 60 * 1000;
const VERSION_FILE = "notebook/package.json"; // where the product keeps its version (the release step edits only this and the README)
export const GUIDE_LINE = "Guide-Reviewed: none-needed (only the version number changed)";

// One issue in the product repository, filed with the builder App's token (as keep-main-green files its tickets),
// minted when the first one is filed: never root's own gh login, which is the owner's. -> ({title, body, labels}) => {number, url}
export function realIssueFiler({ cfg, env }) {
  const kcfg = K.loadConfig({ ...env, KEEP_MAIN_GREEN_REPO: cfg.repo, KEEP_MAIN_GREEN_STATE_DIR: cfg.stateDir });
  let hub = null;
  return async ({ title, body, labels }) => {
    hub ||= K.realHub({ cfg: kcfg, api: R.retrying(R.githubApi(K.mintToken(kcfg, env), env)) });
    return hub.createIssue({ title, body, labels });
  };
}

// itemIssues and readIssues come from auto-stage.mjs (passed in: that module imports this one).
export function realDrive({ cfg, env, api, log, itemIssues, readIssues }) {
  const kcfg = K.loadConfig({ ...env, KEEP_MAIN_GREEN_REPO: cfg.repo, KEEP_MAIN_GREEN_STATE_DIR: cfg.stateDir });
  let built = null;
  const refused = {}; // pull request -> merges GitHub refused in this look; a merge it keeps refusing across looks ends at the wait limit in auto-drive.mjs
  // The builder App's token, minted when the first step needs it.
  const tools = () => {
    if (built) return built;
    const token = K.mintToken(kcfg, env);
    const bapi = R.retrying(R.githubApi(token, env), { log }); // its reads are asked again on 5xx, as the stage's own (issue #155)
    built = {
      token,
      bapi,
      hub: K.realHub({ cfg: kcfg, api: bapi }),
      git: K.makeGit({ dir: path.join(cfg.stateDir, "product.git"), remote: kcfg.remote, name: kcfg.gitName, email: kcfg.gitEmail }),
    };
    return built;
  };
  const read = async (p) => {
    const r = await api("GET", p);
    if (!r.ok) R.refuse(`GitHub said ${r.status} to ${p}.`);
    return r.json;
  };

  return {
    // {item: {number, commit}}: the pull request that delivered each plan item (merged into main).
    itemPulls: async ({ plan, base }) => {
      const items = itemIssues(plan);
      const label = base.includes("-") ? base.slice(base.indexOf("-") + 1) : base;
      const { issues } = await readIssues({ api, repo: cfg.repo, label, numbers: Object.values(items) });
      const out = {};
      for (const [item, number] of Object.entries(items)) {
        const m = ((issues[number] && issues[number].merges) || [])
          .filter((x) => x.mergedAt && x.commit && (!x.repo || x.repo.toLowerCase() === cfg.repo.toLowerCase()) && (!x.base || x.base === "main"))
          .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))[0];
        if (m) out[item] = { number: m.number, commit: m.commit };
      }
      return out;
    },
    pullFiles: async (number) => {
      const files = [];
      for (let page = 1; page <= 5; page++) {
        const list = await read(`/repos/${cfg.repo}/pulls/${number}/files?per_page=100&page=${page}`);
        files.push(...list.map((f) => f.filename));
        if (list.length < 100) break;
      }
      return files;
    },
    // -> {pr, head} | {cannot}
    startRevert: async ({ number, commit, why }) => {
      const { hub, git, token } = tools();
      const pull = await hub.pull(number);
      const title = `Revert "${pull.title}"`;
      const message = `${title}\n\nThis reverts commit ${commit}.\n\nThe release's scenarios failed with it (${why}), so it is taken back out by the release driver and its ticket moves to the next release.\n\n${K.TRAILER} ${commit}\n`;
      const branch = `${kcfg.branchPrefix}${commit.slice(0, 12)}`;
      const found = await hub.findPull(branch);
      if (found && found.state === "open") return { pr: found.number, head: found.head };
      const made = git.make({ culprit: commit, message });
      if (made.conflict) return { cannot: `it conflicts with what main holds now (${made.conflict.join(", ") || "git named no file"})` };
      if (made.empty) return { cannot: "main no longer holds its change" };
      const pushed = git.push({ head: made.head, branch, token });
      if (!pushed.ok) return { cannot: `the revert could not be pushed (${pushed.refused})` };
      const opened = await hub.openPull({ branch, title, body: `Takes #${number} back out of main (${commit}).\n\n${why}\n\nOpened by auto-stage under the release plan's dead-end rule; squash-merged once \`${kcfg.checkName}\` passes.\n` });
      return { pr: opened.number, head: opened.head };
    },
    // -> {pr, head} | {cannot}. The rebuild on the release's own branch (auto-drive.mjs): <branch> is made at
    // <from>, the failed candidate's own commit (or is already there, for a second rebuild), and one pull
    // request into it carries the same change set as the revert on main plus the version change: the revert
    // of <culprit> on top of <from>, then the version. main is never read for it, so main may move on.
    startRelease: async ({ branch, from, culprit, number, why, version }) => {
      const { bapi, hub, git, token } = tools();
      const work = `auto-stage/release-${version}`;
      // opened (or even merged) by a look that crashed before it could save that: carry on with it
      const found = await hub.findPull(work);
      if (found && (found.state === "open" || found.merged)) return { pr: found.number, head: found.head };
      const ref = await bapi("GET", `/repos/${cfg.repo}/git/ref/heads/${branch}`);
      if (ref.ok) {
        const at = ref.json && ref.json.object && ref.json.object.sha;
        if (at !== from) return { cannot: `${branch} is at ${String(at).slice(0, 7)}, not at the failed candidate's own commit ${from.slice(0, 7)}, so somebody else changed it` };
      } else if (ref.status === 404) {
        const made = await bapi("POST", `/repos/${cfg.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: from });
        if (!made.ok) return { cannot: `${branch} could not be made at ${from.slice(0, 7)} (status ${made.status})` };
      } else {
        return { cannot: `${branch} could not be read (status ${ref.status})` };
      }
      const pull = await hub.pull(number);
      const message = `Revert "${pull.title}" on ${branch}\n\nThis reverts commit ${culprit}.\n\nThe release's scenarios failed with it (${why}), so the release driver takes it out of the candidate's own code; the same revert goes to main on its own.\n`;
      const made = git.make({ culprit, message, onto: from });
      if (made.conflict) return { cannot: `taking it out of the candidate's own code conflicts (${made.conflict.join(", ") || "git named no file"})` };
      if (made.empty) return { cannot: "the candidate's own code does not hold its change" };
      const pushed = git.push({ head: made.head, branch: work, token });
      if (!pushed.ok) return { cannot: `the rebuild could not be pushed (${pushed.refused})` };
      // The version, as a second commit on the same branch (the push above starts it afresh, so a look that
      // crashed half way through writes it again rather than finding it there).
      const file = await bapi("GET", `/repos/${cfg.repo}/contents/${VERSION_FILE}?ref=${encodeURIComponent(work)}`);
      if (!file.ok) return { cannot: `${VERSION_FILE} could not be read (status ${file.status})` };
      const text = Buffer.from(file.json.content, "base64").toString("utf8");
      const next = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
      if (next === text) return { cannot: `${VERSION_FILE} has no version line to change` };
      const put = await bapi("PUT", `/repos/${cfg.repo}/contents/${VERSION_FILE}`, { message: `Release step of ${version}: the version\n\n${GUIDE_LINE}\n`, content: Buffer.from(next).toString("base64"), sha: file.json.sha, branch: work });
      if (!put.ok) return { cannot: `the version could not be written (status ${put.status})` };
      const opened = await hub.openPull({
        branch: work,
        base: branch,
        title: `${version}: ${branch} without #${number}`,
        body: `Rebuilds the release on ${branch} from the failed candidate's own commit (${from}): takes #${number} back out (${culprit}) and sets the version to ${version}. Nothing else changes. main is not touched here; the same revert goes to main in its own pull request.\n\n${why}\n\nOpened by auto-stage under the release plan's dead-end rule; squash-merged once \`${kcfg.checkName}\` passes.\n\n${GUIDE_LINE}\n`,
      });
      return { pr: opened.number, head: opened.head };
    },
    // The commits between two commits of a branch, other than the allowed ones (the rebuild's own merge).
    extraCommits: async ({ from, to, allowed }) => {
      const r = await read(`/repos/${cfg.repo}/compare/${from}...${to}`);
      const shas = (r.commits || []).map((c) => c.sha);
      if (r.total_commits > shas.length) return [...shas, "more-than-listed"]; // GitHub lists at most 250: too many to be just these two
      return shas.filter((s) => !allowed.includes(s));
    },
    // A pull request opened here: merged once its check passes. -> {state: "waiting"|"merged"|"failed", sha, why}
    follow: async ({ pr, head, openedAt, culprit = null, kind = "bump" }) => {
      const { hub } = tools();
      const p = await hub.pull(pr);
      if (p.merged) return { state: "merged", sha: p.mergeCommit };
      if (p.state === "closed") return { state: "failed", why: "it was closed without being merged" };
      if (p.head !== head) return { state: "failed", why: "somebody pushed to it, so it is theirs now" };
      const req = await hub.required(p.head);
      if (req.state === "failed") {
        await hub.closePull(pr, `its ${kcfg.checkName} check failed, so the release driver gave up on it`);
        return { state: "failed", why: `its ${kcfg.checkName} check failed` };
      }
      if (req.state !== "passed") {
        const age = Date.now() - Date.parse(openedAt);
        if (age > kcfg.revertCheckMinutes * MINUTE) {
          await hub.closePull(pr, `no ${kcfg.checkName} result after ${Math.round(age / MINUTE)} minutes, so the release driver gave up on it`);
          return { state: "failed", why: `no ${kcfg.checkName} result after ${Math.round(age / MINUTE)} minutes` };
        }
        return { state: "waiting" };
      }
      // A revert keeps its own commit message (it says what it reverts, and keep-main-green knows it by that); the version change says what it is.
      // The rebuild on the release branch carries no trailer: keep-main-green reads that trailer on main only.
      const message = kind === "revert" ? `This reverts commit ${culprit}.\n\n${K.TRAILER} ${culprit}\n` : kind === "release" ? `This reverts commit ${culprit} and sets the version.\n\n${GUIDE_LINE}\n` : `${GUIDE_LINE}\n`;
      const merged = await hub.merge(pr, { sha: p.head, title: `${p.title} (#${pr})`, message });
      if (merged.ok) return { state: "merged", sha: merged.sha };
      refused[pr] = (refused[pr] || 0) + 1;
      if (refused[pr] >= kcfg.mergeTries) return { state: "failed", why: `GitHub refused to merge it ${refused[pr]} times (${merged.message})` };
      log(`GitHub refused to merge #${pr} now (${merged.message}); the next look tries again.`);
      return { state: "waiting" };
    },
  };
}

// The version change of the release step (auto-stage.mjs versionStep): opened with the builder App as ONE
// commit on release/version-<version> (notebook/package.json and the README together, so its checks run
// once), approved and merged with the release App, whose token is narrowed to pull requests and contents
// of this one repository. Nothing here decides anything.
export function realVersionPull({ cfg, env, log, readmeWith, versionWith }) {
  const kcfg = K.loadConfig({ ...env, KEEP_MAIN_GREEN_REPO: cfg.repo, KEEP_MAIN_GREEN_STATE_DIR: cfg.stateDir });
  let built = null;
  const builder = () => {
    if (!built) {
      const bapi = R.retrying(R.githubApi(K.mintToken(kcfg, env), env), { log }); // its reads are asked again on 5xx (issue #155)
      built = { bapi, hub: K.realHub({ cfg: kcfg, api: bapi }) };
    }
    return built;
  };
  const bad = (r) => `status ${r.status}${r.json && r.json.message ? `, ${r.json.message}` : ""}`;
  const repo = cfg.repo;
  return {
    find: async (branch) => builder().hub.findPull(branch),
    // The version main's notebook/package.json carries now, or null when it cannot be read.
    mainVersion: async () => {
      const r = await builder().bapi("GET", `/repos/${repo}/contents/${VERSION_FILE}?ref=main`);
      if (!r.ok) return null;
      const m = Buffer.from(r.json.content, "base64").toString("utf8").match(/"version"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    },
    // -> {pr, head} | {cannot}
    open: async ({ branch, version, title, body, section, message }) => {
      const { bapi, hub } = builder();
      const ref = await bapi("GET", `/repos/${repo}/git/ref/heads/main`);
      if (!ref.ok) return { cannot: `main could not be read (${bad(ref)})` };
      const main = ref.json.object.sha;
      const commit = await bapi("GET", `/repos/${repo}/git/commits/${main}`);
      if (!commit.ok) return { cannot: `main's commit could not be read (${bad(commit)})` };
      const read = async (file) => {
        const r = await bapi("GET", `/repos/${repo}/contents/${file}?ref=${main}`);
        return r.ok ? Buffer.from(r.json.content, "base64").toString("utf8") : null;
      };
      const pkg = await read(VERSION_FILE);
      const readme = await read("README.md");
      if (pkg === null || readme === null) return { cannot: `${pkg === null ? VERSION_FILE : "README.md"} could not be read on main` };
      const nextPkg = versionWith(pkg, version);
      if (nextPkg === null) return { cannot: `${VERSION_FILE} has no version line to change` };
      const nextReadme = readmeWith(readme, version, section);
      const tree = [];
      for (const [p, text, was] of [[VERSION_FILE, nextPkg, pkg], ["README.md", nextReadme, readme]]) {
        if (text === was) continue;
        const blob = await bapi("POST", `/repos/${repo}/git/blobs`, { content: text, encoding: "utf-8" });
        if (!blob.ok) return { cannot: `${p} could not be written (${bad(blob)})` };
        tree.push({ path: p, mode: "100644", type: "blob", sha: blob.json.sha });
      }
      if (!tree.length) return { cannot: "main already says this version and has its README section" };
      const t = await bapi("POST", `/repos/${repo}/git/trees`, { base_tree: commit.json.tree.sha, tree });
      if (!t.ok) return { cannot: `the change could not be made (${bad(t)})` };
      const c = await bapi("POST", `/repos/${repo}/git/commits`, { message, tree: t.json.sha, parents: [main] });
      if (!c.ok) return { cannot: `the change could not be committed (${bad(c)})` };
      // The branch is ours (no pull request names it, or find would have found it): made, or moved to this commit.
      let b = await bapi("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: c.json.sha });
      if (!b.ok && b.status === 422) b = await bapi("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: c.json.sha, force: true });
      if (!b.ok) return { cannot: `${branch} could not be pushed (${bad(b)})` };
      const opened = await hub.openPull({ branch, title, body });
      log(`The version change is on ${branch} (${c.json.sha.slice(0, 7)}).`);
      return { pr: opened.number, head: opened.head };
    },
    required: async (sha) => builder().hub.required(sha),
    // The checks of a commit that did not pass, with the gate's own one-line reason, in one sentence.
    failures: async (sha) => {
      const r = await builder().bapi("GET", `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`);
      if (!r.ok) return `GitHub did not say which (${bad(r)})`;
      const runs = r.json.check_runs || [];
      const failed = runs.filter((x) => x.status === "completed" && !["success", "neutral", "skipped"].includes(x.conclusion));
      const gate = runs.find((x) => x.name === kcfg.checkName && x.output && (x.output.title || x.output.summary));
      const names = failed.filter((x) => x.name !== kcfg.checkName).map((x) => `"${x.name}"`);
      const why = gate ? String(gate.output.title || gate.output.summary).split("\n")[0].trim() : "";
      return [names.length ? `${names.join(", ")} failed` : "", why].filter(Boolean).join("; ") || "its required check failed and names no other check";
    },
    // -> {ok, sha} | {ok: false, message}
    merge: async ({ pr, head, title, message }) => {
      const api = R.retrying(R.githubApi(R.mintToken(env, repo, "pull_requests=write,contents=write"), env), { log });
      const review = await api("POST", `/repos/${repo}/pulls/${pr}/reviews`, { commit_id: head, event: "APPROVE", body: "The release step's version change: its required check passed." });
      if (!review.ok) log(`The release App's approval of #${pr} was refused (${bad(review)}); merging anyway, as the release step may.`);
      const m = await api("PUT", `/repos/${repo}/pulls/${pr}/merge`, { merge_method: "squash", sha: head, commit_title: title, commit_message: message });
      return m.ok && m.json && m.json.merged ? { ok: true, sha: m.json.sha } : { ok: false, message: bad(m) };
    },
  };
}
