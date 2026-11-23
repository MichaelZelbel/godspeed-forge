// Stand-ins for the owner requests' and steps' tests: a GitHub served on 127.0.0.1 from memory (it checks each
// App's signed JWT with the App's public key and hands out installation tokens for one repository), a bridge to
// Godspeed that says each message once per id as the real one does (and keeps every attempt, so a test also sees
// a repeat the bridge dropped), and the Forge's private state for a project set up with two Apps. No network, no AI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const tmpDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------- GitHub
export async function fakeGithub() {
  // workflowShas: commits that bring in a change under .github/workflows/; GitHub refuses an App (no Workflows
  // permission) a branch move to one of them, and lets the owner's own sign-in (token `owner-user-token`) make it.
  // ownerLogin: the GitHub login of this server's gh sign-in (GET /user with the owner's token)
  const S = { repos: {}, apps: {}, installations: {}, tokens: { 'owner-user-token': { repository: '*', role: 'owner' } }, calls: [], fail: [], next: 1000, tokenCount: 0, expiresInMs: 3600 * 1000, workflowShas: new Set(), ownerLogin: 'the-owner' };
  const WORKFLOW_REFUSAL = { message: 'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission' };
  const repo = full => {
    if (!S.repos[full]) S.repos[full] = { default_branch: 'main', issues: [], pulls: [], releases: [], refs: {}, comments: {}, checkRuns: [], latestId: null };
    return S.repos[full];
  };
  const addApp = (full, role) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const id = S.next++;
    const installation = S.next++;
    S.apps[id] = { publicKey, role, repository: full, installation };
    S.installations[installation] = { app: id, repository: full, role };
    return { id, pem: privateKey.export({ type: 'pkcs1', format: 'pem' }), slug: `forge-${role}-${id}`, name: `Forge ${role}` };
  };
  const verifyJwt = header => {
    const jwt = String(header || '').replace(/^Bearer\s+/i, '');
    const [h, p, sig] = jwt.split('.');
    if (!h || !p || !sig) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
    const app = S.apps[payload.iss];
    if (!app) return null;
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), app.publicKey, Buffer.from(sig, 'base64url'));
    return ok ? { ...app, id: Number(payload.iss), payload } : null;
  };
  const latestOf = r => {
    const explicit = r.releases.find(x => x.id === r.latestId && !x.prerelease && !x.draft);
    return explicit || null;
  };
  const relink = r => {
    if (latestOf(r)) return;
    const candidates = r.releases.filter(x => !x.prerelease && !x.draft);
    r.latestId = candidates.length ? candidates.at(-1).id : null;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || '';
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      const call = { method: req.method, path: u.pathname, query: u.search, body, role: null };
      S.calls.push(call);
      // S.fail: [{ method, path, status, times, skip }]: the matching call fails `times` times, after `skip` that pass
      const failing = S.fail.find(f => f.method === req.method && f.path.test(u.pathname) && f.times > 0);
      if (failing && failing.skip > 0) failing.skip--;
      else if (failing) { failing.times--; return send(failing.status || 500, { message: 'the stand-in refused it' }); }
      let m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname);
      if (m && req.method === 'POST') {
        const app = verifyJwt(auth);
        if (!app) return send(401, { message: 'A JSON web token could not be decoded' });
        const inst = S.installations[m[1]];
        if (!inst || inst.app !== app.id) return send(404, { message: 'Not Found' });
        const token = `ghs_${inst.role}_${++S.tokenCount}`;
        S.tokens[token] = { repository: inst.repository, role: inst.role };
        call.role = inst.role;
        return send(201, { token, expires_at: new Date(Date.now() + S.expiresInMs).toISOString() });
      }
      if (u.pathname === '/user' && req.method === 'GET') {
        const who = S.tokens[auth.replace(/^Bearer\s+/i, '')];
        if (!who || who.role !== 'owner') return send(401, { message: 'Bad credentials' });
        return send(200, { login: S.ownerLogin });
      }
      m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
      if (!m) return send(404, { message: 'Not Found' });
      const full = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      const rest = m[3] || '';
      if (rest === '/installation') {
        const app = verifyJwt(auth);
        if (!app) return send(401, { message: 'A JSON web token could not be decoded' });
        if (app.repository !== full) return send(404, { message: 'Not Found' });
        return send(200, { id: app.installation });
      }
      const who = S.tokens[auth.replace(/^Bearer\s+/i, '')];
      if (!who) return send(401, { message: 'Bad credentials' });
      if (who.repository !== full && who.repository !== '*') return send(404, { message: 'Not Found' });
      call.role = who.role;
      const r = repo(full);
      const page = rows => {
        const per = Number(u.searchParams.get('per_page') || 30), p = Number(u.searchParams.get('page') || 1);
        return rows.slice((p - 1) * per, p * per);
      };
      const writes = req.method !== 'GET';
      if (writes && who.role === 'builder' && /^\/(releases|git\/refs)/.test(rest)) return send(403, { message: 'Resource not accessible by integration' });
      if (writes && who.role === 'release' && /^\/issues/.test(rest)) return send(403, { message: 'Resource not accessible by integration' });
      if (req.method === 'DELETE') return send(204);
      if (rest === '' && req.method === 'GET') return send(200, { full_name: full, default_branch: r.default_branch });
      // releases
      if (rest === '/releases/latest' && req.method === 'GET') { const l = latestOf(r); return l ? send(200, l) : send(404, { message: 'Not Found' }); }
      if (rest === '/releases' && req.method === 'GET') return send(200, page([...r.releases].reverse()));
      if (rest === '/releases' && req.method === 'POST') {
        if (r.releases.some(x => x.tag_name === body.tag_name)) return send(422, { message: 'Validation Failed' });
        const id = S.next++;
        if (!r.refs[`tags/${body.tag_name}`]) r.refs[`tags/${body.tag_name}`] = r.refs[`heads/${body.target_commitish}`] || body.target_commitish;
        const rel = { id, tag_name: body.tag_name, name: body.name, body: body.body, prerelease: !!body.prerelease, draft: !!body.draft, html_url: `https://github.example/${full}/releases/${id}`, published_at: new Date().toISOString() };
        r.releases.push(rel);
        if (body.make_latest === 'true' || ((body.make_latest === undefined || body.make_latest === 'legacy') && !rel.prerelease && !rel.draft)) r.latestId = id;
        relink(r);
        return send(201, rel);
      }
      m = /^\/releases\/tags\/(.+)$/.exec(rest);
      if (m && req.method === 'GET') { const rel = r.releases.find(x => x.tag_name === decodeURIComponent(m[1])); return rel ? send(200, rel) : send(404, { message: 'Not Found' }); }
      m = /^\/releases\/(\d+)$/.exec(rest);
      if (m && req.method === 'PATCH') {
        const rel = r.releases.find(x => x.id === Number(m[1]));
        if (!rel) return send(404, { message: 'Not Found' });
        for (const k of ['tag_name', 'name', 'body', 'prerelease', 'draft']) if (body[k] !== undefined) rel[k] = body[k];
        if (body.make_latest === 'true' && !rel.prerelease && !rel.draft) r.latestId = rel.id;
        if (rel.id === r.latestId && (rel.prerelease || rel.draft)) r.latestId = null;
        relink(r);
        return send(200, rel);
      }
      // refs
      m = /^\/git\/ref\/(.+)$/.exec(rest);
      if (m && req.method === 'GET') {
        const ref = decodeURIComponent(m[1]);
        return r.refs[ref] ? send(200, { ref: `refs/${ref}`, object: { type: 'commit', sha: r.refs[ref] } }) : send(404, { message: 'Not Found' });
      }
      if (rest === '/git/refs' && req.method === 'POST') {
        const ref = String(body.ref).replace(/^refs\//, '');
        if (r.refs[ref]) return send(422, { message: 'Reference already exists' });
        if (ref.startsWith('heads/') && who.role !== 'owner' && S.workflowShas.has(body.sha)) return send(422, WORKFLOW_REFUSAL);
        r.refs[ref] = body.sha;
        return send(201, { ref: body.ref, object: { type: 'commit', sha: body.sha } });
      }
      m = /^\/git\/refs\/(heads\/.+)$/.exec(rest);
      if (m && req.method === 'PATCH') {
        const ref = decodeURIComponent(m[1]);
        if (!r.refs[ref]) return send(422, { message: 'Reference does not exist' });
        if (who.role !== 'owner' && S.workflowShas.has(body.sha)) return send(422, WORKFLOW_REFUSAL);
        r.refs[ref] = body.sha;
        return send(200, { ref: `refs/${ref}`, object: { type: 'commit', sha: body.sha } });
      }
      // issues and comments
      if (rest === '/issues' && req.method === 'GET') {
        const st = u.searchParams.get('state') || 'open';
        const rows = [...r.issues, ...r.pulls.map(p => ({ ...p, pull_request: { url: 'x' } }))].filter(i => st === 'all' || i.state === st);
        if (u.searchParams.get('direction') === 'desc') rows.sort((a, b) => b.number - a.number);
        return send(200, page(rows));
      }
      if (rest === '/issues' && req.method === 'POST') {
        const number = r.issues.length + r.pulls.length + 1;
        const issue = { number, title: body.title, body: body.body, state: 'open', labels: [], user: { login: 'forge-builder[bot]', type: 'Bot' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: `https://github.example/${full}/issues/${number}` };
        r.issues.push(issue);
        return send(201, issue);
      }
      m = /^\/issues\/(\d+)$/.exec(rest);
      if (m && req.method === 'GET') { const i = r.issues.find(x => x.number === Number(m[1])); return i ? send(200, i) : send(404, { message: 'Not Found' }); }
      m = /^\/issues\/(\d+)\/comments$/.exec(rest);
      if (m && req.method === 'GET') return send(200, page(r.comments[m[1]] || []));
      if (m && req.method === 'POST') {
        const list = (r.comments[m[1]] ||= []);
        const c = { id: S.next++, body: body.body, user: { login: `forge-${who.role}[bot]` } };
        list.push(c);
        return send(201, c);
      }
      // pull requests
      if (rest === '/pulls' && req.method === 'GET') {
        const st = u.searchParams.get('state') || 'open', base = u.searchParams.get('base');
        return send(200, page(r.pulls.filter(p => (st === 'all' || p.state === st) && (!base || p.base.ref === base))));
      }
      m = /^\/pulls\/(\d+)$/.exec(rest);
      if (m && req.method === 'GET') { const p = r.pulls.find(x => x.number === Number(m[1])); return p ? send(200, p) : send(404, { message: 'Not Found' }); }
      m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest);
      if (m && req.method === 'GET') return send(200, { total_count: r.checkRuns.length, check_runs: page(r.checkRuns) });
      return send(404, { message: 'Not Found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  // A merged pull request that delivers an issue, as the factory makes one: "Closes #n", merged into main.
  const merge = (full, issueNumber, sha, { mergedAt = new Date().toISOString(), closeIssue = true } = {}) => {
    const r = repo(full);
    const number = r.issues.length + r.pulls.length + 1;
    r.pulls.push({ number, title: `Deliver #${issueNumber}`, body: `Closes #${issueNumber}`, state: 'closed', merged_at: mergedAt, merge_commit_sha: sha, base: { ref: r.default_branch }, user: { login: 'forge-builder[bot]', type: 'Bot' }, created_at: mergedAt });
    if (closeIssue) { const i = r.issues.find(x => x.number === issueNumber); if (i) i.state = 'closed'; }
    return number;
  };
  const writes = () => S.calls.filter(c => c.method !== 'GET');
  // An open issue someone wrote; labels are names.
  const issue = (full, { labels = [], ...fields } = {}) => {
    const r = repo(full);
    const number = r.issues.length + r.pulls.length + 1;
    const i = { number, state: 'open', body: '', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), updated_at: new Date().toISOString(), html_url: `https://github.example/${full}/issues/${number}`, ...fields, labels: labels.map(name => ({ name })) };
    r.issues.push(i);
    return i;
  };
  return { url, S, repo, addApp, merge, issue, writes, close: () => new Promise(resolve => server.close(resolve)) };
}

// ---------------------------------------------------------------- the owner's own gh
// A stand-in for this server's gh signed in as the owner: `gh api -X <method> <path> -f k=v -F k=v` against the
// stand-in GitHub with the owner's token. -> { command, calls() } (each call's arguments, in order)
export function standInGh(github, dir = tmpDir('forge-gh-')) {
  const command = path.join(dir, 'gh');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(command, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
    "let method = 'GET', target = '', body = {}, jq = null;",
    'for (let i = 1; i < args.length; i++) {',
    "  if (args[i] === '-X') method = args[++i];",
    "  else if (args[i] === '--jq') jq = args[++i];",
    "  else if (args[i] === '-f' || args[i] === '-F') { const flag = args[i]; const raw = args[++i]; const at = raw.indexOf('='); let v = raw.slice(at + 1); if (flag === '-F' && (v === 'true' || v === 'false')) v = v === 'true'; body[raw.slice(0, at)] = v; }",
    '  else target = args[i];',
    '}',
    `fetch(${JSON.stringify(github.url)} + '/' + target, { method, headers: { authorization: 'Bearer owner-user-token', 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })`,
    "  .then(async r => { const t = await r.text(); if (!r.ok) { process.stderr.write('gh: ' + t + ' (HTTP ' + r.status + ')\\n'); process.exit(1); } process.stdout.write(jq && /^\\.\\w+$/.test(jq) ? String(JSON.parse(t)[jq.slice(1)]) + '\\n' : t); })",
    "  .catch(e => { process.stderr.write(String(e) + '\\n'); process.exit(1); });",
    ''
  ].join('\n'), { mode: 0o755 });
  return { command, calls: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } } };
}

// ---------------------------------------------------------------- the bridge to Godspeed
// Like the real bridge (lib/godspeed.mjs), it says a message once per id: `sent` holds what reached the owner,
// `attempts` every call, repeats included.
export function standInBridge(workspace = tmpDir('forge-workspace-')) {
  const sent = [];
  const attempts = [];
  return {
    workspace,
    sent,
    attempts,
    async readWorkspaceFile(rel) {
      try { return fs.readFileSync(path.join(workspace, rel), 'utf8'); } catch { return null; }
    },
    async writeWorkspaceFile(rel, content) {
      const file = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    async sendToOwner(text, { id } = {}) {
      attempts.push({ text, id });
      if (id && sent.some(s => s.id === id)) return 'already';
      sent.push({ text, id });
      return 'notice';
    },
    json(rel) {
      try { return JSON.parse(fs.readFileSync(path.join(workspace, rel), 'utf8')); } catch { return null; }
    },
  };
}

// ---------------------------------------------------------------- the Forge's state for a set-up project
export function setUpProject(state, github, repository, { checkout = null } = {}) {
  const [owner, name] = repository.split('/');
  const project = path.join(state, 'projects', owner, name);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'registration.json'), JSON.stringify({ repository, checkout, completed: true }));
  const credentials = path.join(state, 'credentials', owner, name);
  fs.mkdirSync(credentials, { recursive: true });
  const apps = {};
  for (const role of ['builder', 'release']) {
    apps[role] = github.addApp(repository, role);
    fs.writeFileSync(path.join(credentials, `${role}-app.json`), JSON.stringify(apps[role]));
  }
  github.repo(repository);
  return apps;
}

// ---------------------------------------------------------------- a project checkout with an origin on this machine
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
export function projectCheckout(root, harness) {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  fs.mkdirSync(path.join(work, 'harness'), { recursive: true });
  fs.mkdirSync(path.join(work, 'factory'), { recursive: true });
  fs.writeFileSync(path.join(work, 'factory', 'consumer.py'), [
    'import pathlib, sys',
    'root = pathlib.Path.cwd() / ".factory"',
    'root.mkdir(exist_ok=True)',
    'with open(root / "consumer.log", "a") as f:',
    '    f.write(" ".join(sys.argv[1:]) + "\\n")',
    'if sys.argv[1:] == ["pause"]:',
    '    (root / "PAUSE").write_text("paused\\n")',
    'elif sys.argv[1:] == ["unpause"]:',
    '    (root / "PAUSE").unlink(missing_ok=True)',
    ''
  ].join('\n'));
  const commit = (config, message) => {
    fs.writeFileSync(path.join(work, 'harness', 'harness.config.json'), JSON.stringify(config));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '--allow-empty', '-m', message);
    git(work, 'push', '-q', origin, 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const first = commit(harness, 'first');
  git(root, 'clone', '-q', origin, checkout);
  return { origin, work, checkout, first, commit, consumerLog: () => { try { return fs.readFileSync(path.join(checkout, '.factory', 'consumer.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } } };
}

// The rules every owner text is held to, as a test reads them: no long dashes, no internal names, at most one link.
export function assertPlain(assert, text) {
  assert.doesNotMatch(text, /[–—]/, `no long dash: ${text}`);
  assert.doesNotMatch(text, /\b(?:workflow|merge gate|judge|holdout|ticket|pull request|harness|scenario)s?\b/i, `no internal name: ${text}`);
  assert.doesNotMatch(text, /#\d/, `no item number: ${text}`);
  assert.ok((text.match(/https?:\/\//g) || []).length <= 1, `at most one link: ${text}`);
}
