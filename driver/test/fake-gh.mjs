#!/usr/bin/env node
// A stand-in for gh that answers from a JSON file instead of GitHub (the owner guard's tests, issue #152).
//   node fake-gh.mjs --state <file.json> <gh arguments...>
// The file: {repo, appLogin, users: {token: login}, comments: {"owner/repo#n": [{body, user: {login}, created_at}]}, posts: []}
// Which token a call uses is found the way gh finds it: GH_TOKEN, then GITHUB_TOKEN, then the hosts.yml of GH_CONFIG_DIR, of
// XDG_CONFIG_HOME/gh, of HOME/.config/gh. FAKE_GH_REAL_AUTH=<gh> hands `auth token` to that real gh instead.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
if (argv[0] !== "--state") { process.stderr.write("fake gh: --state <file> first\n"); process.exit(2); }
const file = argv[1];
const args = argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const write = s => fs.writeFileSync(file, JSON.stringify(s, null, 1));
const hostsToken = dir => { try { const m = /^\s*oauth_token:\s*(\S+)/m.exec(fs.readFileSync(path.join(dir, "hosts.yml"), "utf8")); return m ? m[1] : ""; } catch { return ""; } };
const token = () => {
  const e = process.env;
  if (e.GH_TOKEN) return e.GH_TOKEN;
  if (e.GITHUB_TOKEN) return e.GITHUB_TOKEN;
  if (e.GH_CONFIG_DIR) return hostsToken(e.GH_CONFIG_DIR);
  if (e.XDG_CONFIG_HOME) return hostsToken(path.join(e.XDG_CONFIG_HOME, "gh"));
  return e.HOME ? hostsToken(path.join(e.HOME, ".config", "gh")) : "";
};
const loginOf = (s, t) => (/^ghs_/.test(t) ? s.appLogin : (s.users || {})[t] || "");
const flag = names => { for (let i = 0; i < args.length; i++) { if (names.includes(args[i])) return args[i + 1]; for (const n of names) if (n.startsWith("--") && args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1); } return null; };
const out = s => { process.stdout.write(s); process.exit(0); };
const fail = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };

const [group, sub] = args;
if (group === "auth" && sub === "token") {
  if (process.env.FAKE_GH_REAL_AUTH) { const r = spawnSync(process.env.FAKE_GH_REAL_AUTH, ["auth", "token"], { encoding: "utf8", env: process.env }); process.stdout.write(r.stdout || ""); process.exit(r.status === null ? 1 : r.status); }
  const t = token();
  if (!t) fail("no oauth token found for github.com");
  out(`${t}\n`);
}
if (group === "auth" && sub === "git-credential") {
  const t = token();
  if (!t || args[2] !== "get") process.exit(t ? 0 : 1);
  out(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${t}\n`);
}
const s = read();
if (group === "api" && sub === "user") {
  const t = token();
  if (/^ghs_/.test(t)) fail("HTTP 403: Resource not accessible by integration (https://api.github.com/user)");
  const login = (s.users || {})[t];
  if (!login) fail("HTTP 401: Bad credentials (https://api.github.com/user)");
  out(`${login}\n`);
}
if (group === "api") {
  const ep = String(sub || "").replace(/^\//, "");
  let m;
  if ((m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=(\d+)&page=(\d+)$/.exec(ep))) {
    const all = (s.comments || {})[`${m[1]}#${m[2]}`] || [];
    const per = Number(m[3]), page = Number(m[4]);
    out(JSON.stringify(all.slice((page - 1) * per, page * per)));
  }
  if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\?/.test(ep)) out("[]");
  out("{}");
}
if (group === "repo" && sub === "view") out(`${s.repo}\n`);
if ((group === "pr" || group === "issue") && sub === "comment") {
  const n = args.slice(2).find(x => /^\d+$/.test(x));
  const repo = flag(["-R", "--repo"]) || s.repo;
  const bodyFile = flag(["--body-file", "-F"]);
  const body = bodyFile ? fs.readFileSync(bodyFile, "utf8") : flag(["--body", "-b"]) || "";
  const t = token();
  const login = loginOf(s, t);
  if (!login) fail("HTTP 401: Bad credentials");
  const c = { body, user: { login }, created_at: process.env.FAKE_GH_NOW || new Date().toISOString() };
  ((s.comments ||= {})[`${repo}#${n}`] ||= []).push(c);
  (s.posts ||= []).push({ repo, number: Number(n), login, body });
  write(s);
  out(`https://github.com/${repo}/pull/${n}#issuecomment-${s.posts.length}\n`);
}
out("");
