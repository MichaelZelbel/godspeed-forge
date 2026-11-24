// What freeze.mjs, promote.mjs and take-back.mjs share (process.md, sections 2, 6 and 7): the
// release token, the GitHub API, the reads a stranger makes from outside, the anonymous registry
// read, and the stage file's format. Node's own modules only, no npm packages.
//
// The stage file and its rules belong to the product (ticket 1): stage.json at the root of
// the product repository, stage.schema.json beside it, and the two readers in
// stage/. Nothing here repeats those rules; checkStage() checks a stage against the real schema
// read at the commit being frozen, and a stage file is always written the one way the readers
// accept: what JSON.stringify(stage, null, 2) writes, with a final newline.
//
// Overrides, for the self-tests and for a throwaway copy of a repository:
//   RELEASE_TOKEN_SCRIPT   default the settings' keys.token_script
//   GITHUB_API_URL         default https://api.github.com
//   GITHUB_UPLOAD_URL      default https://uploads.github.com
//   GITHUB_RAW_URL         default https://raw.githubusercontent.com
//   GHCR_URL               default https://ghcr.io
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cfg } from "./config.mjs";

export const STAGE_FILE = "stage.json";
export const SCHEMA_FILE = "stage.schema.json";
export const PUBLIC_STAGE = "beta";
export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

// The branch a release is rebuilt on when its candidate failed (auto-drive.mjs): release/<version of the
// release>, so 2.0.0-beta.26 and its re-freezes 2.0.0-beta.26.1 and .2 all live on release/2.0.0-beta.26.
// main is never held still for a rebuild; the candidate is cut from its own commit on this branch.
export const releaseBranch = (version) => `release/${String(version).replace(/^(\d+\.\d+\.\d+-[A-Za-z]+\.\d+)\.\d+$/, "$1")}`;

// What each public address serves. The last part of the address says which; the release step gives
// the addresses with --read-back, for example https://godspeedmissioncontrol.com/install.
export const ADDRESSES = {
  install: { what: "the Mac and Linux install line", file: "install-godspeed.sh" },
  server: { what: "the Docker server install line", file: "docker/server/install.sh" },
  windows: { what: "the Windows setup", file: null },
};

// A refusal: one plain sentence, printed, and the command stops without changing anything more.
export class Refused extends Error {}
export function refuse(sentence) {
  throw new Refused(sentence);
}

const trimSlash = (s) => String(s).replace(/\/+$/, "");

export function bases(env = process.env) {
  return {
    api: trimSlash(env.GITHUB_API_URL || "https://api.github.com"),
    upload: trimSlash(env.GITHUB_UPLOAD_URL || "https://uploads.github.com"),
    raw: trimSlash(env.GITHUB_RAW_URL || "https://raw.githubusercontent.com"),
    ghcr: trimSlash(env.GHCR_URL || "https://ghcr.io"),
  };
}

// The only credential these commands ever use: a release App token for this one repository,
// narrowed to what the step needs. The maintainer's own login and any GH_TOKEN in the environment
// are never read.
export function mintToken(env, ownerRepo, permissions) {
  const script = env.RELEASE_TOKEN_SCRIPT || cfg.tokenScript;
  if (!script) refuse("The settings name no script that makes a release token (keys.token_script), so no release token can be made.");
  if (!fs.existsSync(script)) refuse(`${script} is not there, so no release token can be made.`);
  const r = spawnSync(process.execPath, [script, "release", ownerRepo, "--permissions", permissions], { encoding: "utf8", env });
  const token = (r.stdout || "").trim();
  if (r.status !== 0 || !token) {
    const said = (r.stderr || "").trim().split("\n").pop() || `the token script exited ${r.status}`;
    refuse(`No release token for ${ownerRepo} (${permissions}): ${said}`);
  }
  return token;
}

export async function request(method, url, { token, body, bytes, accept, contentType, raw } = {}) {
  const headers = {
    Accept: accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "godspeed-dev-release",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  if (bytes) headers["Content-Type"] = contentType || "application/octet-stream";
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : bytes || undefined,
    redirect: "follow",
  });
  if (raw) {
    const got = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ok: res.ok, bytes: got, url: res.url, headers: res.headers };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ok: res.ok, text, json, url: res.url, headers: res.headers };
}

// A caller for the GitHub API. Without a token it is the read a stranger makes of a public
// repository.
export function githubApi(token, env = process.env) {
  const { api } = bases(env);
  return (method, p, body, opts = {}) => request(method, /^https?:/.test(p) ? p : api + p, { token, body, ...opts });
}

// A GitHub that answers a read with 500 to 599, or not at all, is asked again after a pause: on 2026-11-24 the
// stage step's read of a run's jobs got 502 and the look ended there, while the same read answered at once
// minutes later. Only reads are asked again (GET, HEAD, a GraphQL query); a write is never sent twice.
// budgetMs bounds the pauses of one caller altogether, so a GitHub that stays down costs a look minutes, not hours.
export const RETRY_DELAYS_MS = [5000, 20000, 60000];
export const RETRY_BUDGET_MS = 10 * 60000;
const isRead = (method, p, body) =>
  method === "GET" || method === "HEAD" || (method === "POST" && /\/graphql$/.test(String(p)) && !!body && /^\s*(query\b|\{)/.test(String(body.query || "")));
export function retrying(api, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = RETRY_DELAYS_MS, budgetMs = RETRY_BUDGET_MS, log = null } = {}) {
  let spent = 0;
  return async (method, p, body, opts = {}) => {
    for (let i = 0; ; i++) {
      let r = null;
      let err = null;
      try {
        r = await api(method, p, body, opts);
      } catch (e) {
        err = e;
      }
      const again = isRead(method, p, body) && (err || (r.status >= 500 && r.status <= 599)) && i < delays.length && spent + delays[i] <= budgetMs;
      if (!again) {
        if (err) throw err;
        return r;
      }
      if (log) log(`GitHub answered ${err ? `nothing (${err.message})` : r.status} to ${p}; asking again in ${Math.round(delays[i] / 1000)} seconds.`);
      spent += delays[i];
      await sleep(delays[i]);
    }
  };
}

const said = (r) => (r.json && r.json.message ? ` (${r.json.message})` : "");

export async function refSha(api, ownerRepo, ref) {
  const r = await api("GET", `/repos/${ownerRepo}/git/ref/${ref}`);
  if (r.status === 404) return null;
  if (!r.ok) refuse(`GitHub said ${r.status} to reading ${ref} of ${ownerRepo}${said(r)}.`);
  if (r.json.object && r.json.object.type === "tag") {
    const t = await api("GET", `/repos/${ownerRepo}/git/tags/${r.json.object.sha}`);
    if (!t.ok) refuse(`GitHub said ${t.status} to reading the tag object of ${ref} in ${ownerRepo}${said(t)}.`);
    return t.json.object.sha;
  }
  return r.json.object.sha;
}

export async function commitExists(api, ownerRepo, sha) {
  const r = await api("GET", `/repos/${ownerRepo}/commits/${sha}`);
  if (r.status === 404 || r.status === 422) return false;
  if (!r.ok) refuse(`GitHub said ${r.status} to reading commit ${sha} of ${ownerRepo}${said(r)}.`);
  return true;
}

// Is <sha> reachable from the branch? GitHub compares base...head, so main is ahead of a commit
// already merged into it, and identical to its own tip.
export async function reachableFrom(api, ownerRepo, sha, branch) {
  const r = await api("GET", `/repos/${ownerRepo}/compare/${sha}...${branch}`);
  if (r.status === 404) return false;
  if (!r.ok) refuse(`GitHub said ${r.status} to comparing ${sha} with ${branch} of ${ownerRepo}${said(r)}.`);
  return r.json.status === "ahead" || r.json.status === "identical";
}

export async function readFileAt(api, ownerRepo, file, ref) {
  const r = await api("GET", `/repos/${ownerRepo}/contents/${file}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return null;
  if (!r.ok) refuse(`GitHub said ${r.status} to reading ${file} at ${ref} in ${ownerRepo}${said(r)}.`);
  if (typeof r.json.content !== "string") refuse(`GitHub returned no content for ${file} at ${ref} in ${ownerRepo}.`);
  const bytes = Buffer.from(r.json.content.replace(/\s+/g, ""), "base64");
  return { bytes, text: bytes.toString("utf8"), sha: r.json.sha };
}

export function parseStage(text, where) {
  let stage;
  try {
    stage = JSON.parse(text);
  } catch (e) {
    refuse(`The stage file ${where} is not JSON (${e.message}).`);
  }
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) refuse(`The stage file ${where} is not an object.`);
  return stage;
}

export async function readStageAt(api, ownerRepo, ref) {
  const f = await readFileAt(api, ownerRepo, STAGE_FILE, ref);
  if (!f) return null;
  return { stage: parseStage(f.text, `at ${ref} in ${ownerRepo}`), text: f.text };
}

export async function readSchemaAt(api, ownerRepo, ref) {
  const f = await readFileAt(api, ownerRepo, SCHEMA_FILE, ref);
  if (!f) refuse(`There is no ${SCHEMA_FILE} at ${ref} in ${ownerRepo}, so a stage file cannot be checked against it.`);
  let schema;
  try {
    schema = JSON.parse(f.text);
  } catch (e) {
    refuse(`${SCHEMA_FILE} at ${ref} in ${ownerRepo} is not JSON (${e.message}).`);
  }
  return schema;
}

export const stageText = (stage) => `${JSON.stringify(stage, null, 2)}\n`;
export const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (file) => sha256Of(fs.readFileSync(file));

// Checks a stage against the product's own stage.schema.json: the part of JSON Schema that file
// uses, plus its neverNamedFields list. Returns a list of plain sentences, empty when the stage is
// one the product's readers accept.
export function checkStage(stage, schema, where = "the stage file") {
  const problems = [];
  const never = new Set((schema.neverNamedFields && schema.neverNamedFields.names) || []);
  const kinds = (s) => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []);
  const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const name = (at, s) => `${at || "the stage"}${s && s.title && at ? "" : ""}`;

  const walk = (value, s, at) => {
    if (!s) return;
    if ("const" in s && value !== s.const) {
      problems.push(`${name(at, s)} in ${where} is ${JSON.stringify(value)}, not ${JSON.stringify(s.const)}.`);
      return;
    }
    const want = kinds(s);
    if (want.length && !want.includes(kindOf(value))) {
      problems.push(`${name(at, s)} in ${where} is ${kindOf(value)}, and the schema wants ${want.join(" or ")}.`);
      return;
    }
    if (typeof value === "string" && s.pattern && !new RegExp(s.pattern).test(value)) {
      problems.push(`${name(at, s)} in ${where} is "${value}", which is not ${s.description || `what ${s.pattern} allows`}.`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, s.items, `${at}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      for (const f of s.required || []) {
        if (!keys.includes(f)) problems.push(`${where} names no ${at ? `${at}.${f}` : f}.`);
      }
      if (s.minProperties && keys.length < s.minProperties) {
        problems.push(`${name(at, s)} in ${where} names ${keys.length} field(s), and the schema wants at least ${s.minProperties}.`);
      }
      for (const key of keys) {
        const label = at ? `${at}.${key}` : key;
        if (never.has(key)) {
          problems.push(`${where} names a field ${label}, and a stage file never names a field JavaScript gives every object.`);
          continue;
        }
        const own = s.properties && Object.prototype.hasOwnProperty.call(s.properties, key) ? s.properties[key] : null;
        if (own) {
          walk(value[key], own, label);
          continue;
        }
        let matched = null;
        for (const [pattern, sub] of Object.entries(s.patternProperties || {})) {
          if (new RegExp(pattern).test(key)) matched = sub;
        }
        if (matched) {
          walk(value[key], matched, label);
          continue;
        }
        if (s.additionalProperties === false) problems.push(`${where} names a field ${label} that the schema does not allow.`);
      }
    }
  };

  walk(stage, schema, "");
  return problems;
}

// ---------- the registry, read anonymously ----------

// owner/repository out of
// ghcr.io/owner/repository@sha256:...
export function registryName(image) {
  const repo = String(image).split("@")[0].split(":")[0];
  const cut = repo.indexOf("/");
  if (cut < 0) return repo;
  const host = repo.slice(0, cut);
  return host.includes(".") || host.includes(":") ? repo.slice(cut + 1) : repo;
}

export async function imageDigest(env, image, tag) {
  const { ghcr } = bases(env);
  const name = registryName(image);
  const scope = encodeURIComponent(`repository:${name}:pull`);
  const t = await request("GET", `${ghcr}/token?service=ghcr.io&scope=${scope}`);
  if (!t.ok || !t.json || !t.json.token) {
    refuse(`The registry ${ghcr} gave no anonymous read token for ${name} (it said ${t.status}), so the image cannot be checked.`);
  }
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  const m = await request("GET", `${ghcr}/v2/${name}/manifests/${tag}`, { token: t.json.token, accept, raw: true });
  if (m.status === 404) return null;
  if (!m.ok) refuse(`The registry said ${m.status} to reading ${name}:${tag}.`);
  const digest = m.headers.get("docker-content-digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) refuse(`The registry gave no sha256 digest for ${name}:${tag}.`);
  return digest;
}

// ---------- writing: one commit whose only change is one file ----------

export async function commitOneFile(api, ownerRepo, { parent, file, text, message }) {
  const base = await api("GET", `/repos/${ownerRepo}/git/commits/${parent}`);
  if (!base.ok) refuse(`GitHub said ${base.status} to reading commit ${parent} of ${ownerRepo}${said(base)}.`);
  const blob = await api("POST", `/repos/${ownerRepo}/git/blobs`, { content: Buffer.from(text).toString("base64"), encoding: "base64" });
  if (!blob.ok) refuse(`GitHub said ${blob.status} to writing the new ${file}${said(blob)}.`);
  const tree = await api("POST", `/repos/${ownerRepo}/git/trees`, {
    base_tree: base.json.tree.sha,
    tree: [{ path: file, mode: "100644", type: "blob", sha: blob.json.sha }],
  });
  if (!tree.ok) refuse(`GitHub said ${tree.status} to writing the tree${said(tree)}.`);
  const commit = await api("POST", `/repos/${ownerRepo}/git/commits`, { message, tree: tree.json.sha, parents: [parent] });
  if (!commit.ok) refuse(`GitHub said ${commit.status} to writing the commit${said(commit)}.`);
  return commit.json.sha;
}

export async function changedFiles(api, ownerRepo, sha) {
  const r = await api("GET", `/repos/${ownerRepo}/commits/${sha}`);
  if (!r.ok) refuse(`GitHub said ${r.status} to reading commit ${sha} of ${ownerRepo}${said(r)}.`);
  return (r.json.files || []).map((f) => f.filename);
}

export async function createRef(api, ownerRepo, ref, sha) {
  const r = await api("POST", `/repos/${ownerRepo}/git/refs`, { ref, sha });
  if (!r.ok) refuse(`GitHub said ${r.status} to creating ${ref} in ${ownerRepo}${said(r)}.`);
  return r.json;
}

export async function moveRef(api, ownerRepo, ref, sha) {
  const r = await api("PATCH", `/repos/${ownerRepo}/git/refs/${ref}`, { sha, force: true });
  if (!r.ok) refuse(`GitHub said ${r.status} to moving ${ref} of ${ownerRepo} to ${sha}${said(r)}.`);
  return r.json;
}

// ---------- releases ----------

export async function releaseByTag(api, ownerRepo, tag) {
  const r = await api("GET", `/repos/${ownerRepo}/releases/tags/${encodeURIComponent(tag)}`);
  if (r.status === 404) return null;
  if (!r.ok) refuse(`GitHub said ${r.status} to reading the release of ${tag} in ${ownerRepo}${said(r)}.`);
  return r.json;
}

// A draft release holds its tag name until it is published; target_commitish says which commit the
// tag lands on, for a release tag that does not exist as a tag yet.
export async function createDraftRelease(api, ownerRepo, { tag, name, body, commit }) {
  const r = await api("POST", `/repos/${ownerRepo}/releases`, {
    tag_name: tag,
    ...(commit ? { target_commitish: commit } : {}),
    name,
    body,
    draft: true,
    prerelease: true,
    make_latest: "false",
  });
  if (!r.ok) refuse(`GitHub said ${r.status} to making the draft release for ${tag} in ${ownerRepo}${said(r)}.`);
  return r.json;
}

export async function uploadAsset(release, { name, bytes, token, env = process.env }) {
  const template = String(release.upload_url || "").replace(/\{.*\}$/, "");
  const url = `${template || `${bases(env).upload}/repos/x/releases/${release.id}/assets`}?name=${encodeURIComponent(name)}`;
  const r = await request("POST", url, { token, bytes, contentType: "application/octet-stream" });
  if (!r.ok) refuse(`GitHub said ${r.status} to attaching ${name} to the draft release${said(r)}.`);
  return r.json;
}

export async function assetBytesWithToken(api, ownerRepo, assetId) {
  const r = await api("GET", `/repos/${ownerRepo}/releases/assets/${assetId}`, undefined, {
    accept: "application/octet-stream",
    raw: true,
  });
  if (!r.ok) refuse(`GitHub said ${r.status} to reading asset ${assetId} of ${ownerRepo} back.`);
  return r.bytes;
}

export async function publishPreRelease(api, ownerRepo, id) {
  const r = await api("PATCH", `/repos/${ownerRepo}/releases/${id}`, { draft: false, prerelease: true, make_latest: "false" });
  if (!r.ok) refuse(`GitHub said ${r.status} to publishing release ${id} of ${ownerRepo} as a pre-release${said(r)}.`);
  return r.json;
}

// Marks the release Latest and, when `text` is given, rewrites its title and notes in the same
// request, so no promoted release keeps the text it was frozen with.
export async function markLatest(api, ownerRepo, id, text = null) {
  const r = await api("PATCH", `/repos/${ownerRepo}/releases/${id}`, {
    draft: false,
    prerelease: false,
    make_latest: "true",
    ...(text ? { name: text.name, body: text.body } : {}),
  });
  if (!r.ok) refuse(`GitHub said ${r.status} to marking release ${id} of ${ownerRepo} Latest${said(r)}.`);
  return r.json;
}

export const PUBLIC_INSTALL_LINKS = [
  "https://godspeedmissioncontrol.com/install",
  "https://godspeedmissioncontrol.com/server",
  "https://godspeedmissioncontrol.com/windows",
];

// The "New in <version>" section of the README: from its heading to the next heading of the same
// or a higher level. null when there is none (or it is empty).
export function readmeSection(readme, version) {
  const lines = String(readme || "").replace(/\r\n/g, "\n").split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const head = new RegExp(`^(#{1,6})\\s+.*\\bNew in v?${esc}(?![0-9A-Za-z-]|\\.[0-9A-Za-z])`, "i");
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  if (!lines.slice(start + 1, end).join("").trim()) return null;
  return lines.slice(start, end).join("\n").trim();
}

// A README link such as docs/x.md points nowhere from a release page; make it a link to that file
// at the product commit. Links with a scheme, a # or a leading / are left alone.
export function absoluteLinks(text, ownerRepo, commit) {
  if (!text || !ownerRepo || !commit) return text;
  return text.replace(/\]\((?!#|\/|[A-Za-z][A-Za-z0-9+.-]*:)(\.\/)?([^)\s]+)\)/g, (_m, _dot, p) => `](https://github.com/${ownerRepo}/blob/${commit}/${p})`);
}

// The title and notes a promoted release carries for the public. `readme` is the product README at
// the stage's product commit (null when it could not be read); `fromReadme` says which body it is.
export function publicReleaseText({ version, date, readme, ownerRepo = null, commit = null }) {
  const section = absoluteLinks(readmeSection(readme, version), ownerRepo, commit);
  const links = ["Install:", ...PUBLIC_INSTALL_LINKS.map((u) => `- ${u}`)].join("\n");
  const lead = `Godspeed Mission Control ${version}, released ${date}.`;
  return {
    name: `Godspeed ${version}`,
    body: [lead, "", ...(section ? [section, ""] : []), links].join("\n"),
    fromReadme: !!section,
  };
}

// What a promoted release must not still say from its freeze: one sentence per problem.
export function frozenTextProblems(release, want) {
  const problems = [];
  if (/\(candidate\)/i.test(release.name || "")) problems.push(`its title is still "${release.name}"`);
  if (/not promoted/i.test(release.body || "")) problems.push("its notes still say it is not promoted");
  if (want && release.name !== want.name) problems.push(`its title is "${release.name}", not "${want.name}"`);
  return problems;
}

export function sha256sumsText(files) {
  return `${files.map((f) => `${f.sha256}  ${f.name}`).join("\n")}\n`;
}

// ---------- the reads from outside ----------

// The key the reads from outside use, and nothing else: none at all where the repository is
// public, and where it is private a release token of its own, narrowed to contents=read. Never the
// token the command moved beta or a release with: a read-back is a read.
export function readTokenFor(env, ownerRepo, isPrivate, log) {
  if (!isPrivate) {
    log(`${ownerRepo} is public, so the reads from outside carry no token at all.`);
    return null;
  }
  log(`${ownerRepo} is private, so the reads from outside go through the API with a second release token of their own, narrowed to contents=read.`);
  return mintToken(env, ownerRepo, "contents=read");
}

// How a stranger reads this repository: with no token at all where it is public, through the API
// with the read token of readTokenFor() where it is private.
// wrap: what every read goes through (the stage step passes retrying(), so a 5xx is asked again); default as it is.
export function outside({ env, ownerRepo, isPrivate, token, wrap = (f) => f }) {
  const { raw } = bases(env);
  if (isPrivate && !token) refuse(`${ownerRepo} is private, and the reads from outside were given no read token, so they cannot be made.`);
  const api = wrap(githubApi(isPrivate ? token : null, env));
  const get = wrap((method, url, body, opts) => request(method, url, opts));
  return {
    how: isPrivate ? `the API with a read token (${ownerRepo} is private)` : "no token at all",
    where: (ref, file) => (isPrivate ? `${file} at ${ref} of ${ownerRepo} through the API` : `${raw}/${ownerRepo}/${ref}/${file}`),
    async fileAt(ref, file) {
      if (isPrivate) {
        const f = await readFileAt(api, ownerRepo, file, ref);
        return f ? f.bytes : null;
      }
      const r = await get("GET", `${raw}/${ownerRepo}/${ref}/${file}`, undefined, { raw: true, accept: "*/*" });
      return r.ok ? r.bytes : null;
    },
    async stageAt(ref) {
      const bytes = await this.fileAt(ref, STAGE_FILE);
      if (!bytes) refuse(`${this.where(ref, STAGE_FILE)} could not be read, so what the public gets cannot be checked.`);
      const text = bytes.toString("utf8");
      return { stage: parseStage(text, `read from ${this.where(ref, STAGE_FILE)}`), text };
    },
    async refSha(ref) {
      return refSha(api, ownerRepo, ref);
    },
    async latestRelease() {
      const r = await api("GET", `/repos/${ownerRepo}/releases/latest`);
      if (r.status === 404) return null;
      if (!r.ok) refuse(`Reading the release marked Latest of ${ownerRepo} from outside said ${r.status}${said(r)}.`);
      return r.json;
    },
    async assetBytes(release, name) {
      const asset = (release.assets || []).find((a) => a.name === name);
      if (!asset) return null;
      if (!isPrivate && asset.browser_download_url) {
        const r = await get("GET", asset.browser_download_url, undefined, { raw: true, accept: "*/*" });
        return r.ok ? r.bytes : null;
      }
      return assetBytesWithToken(api, ownerRepo, asset.id);
    },
  };
}

export function addressKind(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const last = parsed.pathname.replace(/\/+$/, "").split("/").pop();
  return Object.prototype.hasOwnProperty.call(ADDRESSES, last) ? last : null;
}

const firstLine = (bytes) => bytes.toString("utf8").split("\n")[0].slice(0, 80);

// What promote and take back both do after they have changed the stage: read back from outside and
// say exactly which address served what. Returns a list of plain sentences; empty means the public
// gets what the stage file says.
//
// A public address can serve a copy it cached a moment ago - raw.githubusercontent.com does, and so
// does a website that was just deployed - so a read-back that does not match is looked at again a
// few times before it is called a mismatch. RELEASE_READ_BACK_LOOKS (default 6) and
// RELEASE_READ_BACK_WAIT_MS (default 5000) say how often and how long apart.
export async function readBackChecks(options) {
  const { env, log } = options;
  const looks = /^\d+$/.test(env.RELEASE_READ_BACK_LOOKS || "") ? Number(env.RELEASE_READ_BACK_LOOKS) : 6;
  const waitMs = /^\d+$/.test(env.RELEASE_READ_BACK_WAIT_MS || "") ? Number(env.RELEASE_READ_BACK_WAIT_MS) : 5000;
  let problems = [];
  for (let look = 1; look <= Math.max(1, looks); look++) {
    problems = await readBackOnce(options);
    if (!problems.length) {
      if (look > 1) log(`  Everything matched on look ${look}; the first ${look - 1} read a copy that was still cached.`);
      return [];
    }
    if (look < looks) {
      log(`  ${problems.length} read-back${problems.length === 1 ? " does" : "s do"} not match yet, which a cached copy can explain; looking again in ${Math.round(waitMs / 1000)} second(s) (look ${look + 1} of ${looks}).`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return problems;
}

const short = (v) => {
  const text = JSON.stringify(v === undefined ? null : v);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

async function readBackOnce({ env, ownerRepo, isPrivate, token, stage, wantText, wantVersion, wantCommit, wantWithdrawn = [], wantRelease = null, urls = [], log }) {
  const out = outside({ env, ownerRepo, isPrivate, token });
  const problems = [];
  log(`Reading back from outside with ${out.how}.`);

  const seen = await out.stageAt(PUBLIC_STAGE);
  log(`  ${out.where(PUBLIC_STAGE, STAGE_FILE)} serves version ${seen.stage.version}, product commit ${String(seen.stage.productCommit).slice(0, 7)}, withdrawn ${JSON.stringify(seen.stage.withdrawn || [])}.`);
  if (seen.stage.version !== wantVersion) {
    problems.push(`${out.where(PUBLIC_STAGE, STAGE_FILE)} served version ${seen.stage.version}, not ${wantVersion}.`);
  }
  for (const v of wantWithdrawn) {
    if (!(seen.stage.withdrawn || []).includes(v)) {
      problems.push(`${out.where(PUBLIC_STAGE, STAGE_FILE)} does not list ${v} as withdrawn; it lists ${JSON.stringify(seen.stage.withdrawn || [])}.`);
    }
  }
  for (const [edition, pin] of Object.entries(stage.serverEditions || {})) {
    const got = ((seen.stage.serverEditions || {})[edition] || {}).image;
    if (got !== pin.image) {
      problems.push(`${out.where(PUBLIC_STAGE, STAGE_FILE)} serves the ${edition} image ${got || "nothing"}, not ${pin.image}.`);
    }
  }
  // Every other field of the stage too, the product commit above all: a stage file that names the
  // right version and the right image can still send every installer to another commit of the
  // product, and then the public is running something nobody approved.
  for (const field of Object.keys(stage)) {
    if (field === "version" || field === "serverEditions") continue; // said in their own words above
    if (JSON.stringify(seen.stage[field]) !== JSON.stringify(stage[field])) {
      problems.push(`${out.where(PUBLIC_STAGE, STAGE_FILE)} serves ${field} ${short(seen.stage[field])}, and the stage of ${wantVersion} says ${short(stage[field])}.`);
    }
  }
  for (const field of Object.keys(seen.stage)) {
    if (!Object.prototype.hasOwnProperty.call(stage, field)) {
      problems.push(`${out.where(PUBLIC_STAGE, STAGE_FILE)} names a field ${field} that the stage of ${wantVersion} does not have.`);
    }
  }
  // Same fields, other bytes: a layout the product's shell reader refuses would still be served.
  if (wantText && seen.text !== wantText && !problems.length) {
    problems.push(`${out.where(PUBLIC_STAGE, STAGE_FILE)} names every field of ${wantVersion} but is not the file that was written (${seen.text.length} bytes against ${wantText.length}), and stage/stage.sh reads only the one layout.`);
  }

  if (wantCommit) {
    const sha = await out.refSha(`heads/${PUBLIC_STAGE}`);
    log(`  ${PUBLIC_STAGE} of ${ownerRepo} sits on commit ${String(sha).slice(0, 7)}.`);
    if (sha !== wantCommit) {
      problems.push(`${PUBLIC_STAGE} of ${ownerRepo}, read from outside, sits on commit ${sha}, not ${wantCommit}.`);
    }
  }

  const latest = await out.latestRelease();
  const wantTag = stage.windowsSetup.releaseTag;
  if (!latest) {
    problems.push(`${ownerRepo} has no release marked Latest, so a stranger on Windows is offered nothing.`);
  } else {
    log(`  The release marked Latest is ${latest.tag_name}.`);
    if (latest.tag_name !== wantTag) problems.push(`The release marked Latest is ${latest.tag_name}, not ${wantTag}.`);
    if (wantRelease) {
      for (const p of frozenTextProblems(latest, wantRelease)) problems.push(`The release marked Latest (${latest.tag_name}) is not ready for the public: ${p}.`);
    }
    const bytes = await out.assetBytes(latest, stage.windowsSetup.file);
    if (!bytes) {
      problems.push(`The release marked Latest (${latest.tag_name}) has no ${stage.windowsSetup.file}.`);
    } else {
      const got = sha256Of(bytes);
      log(`  ${stage.windowsSetup.file} of ${latest.tag_name} has SHA-256 ${got.slice(0, 12)}.`);
      if (got !== stage.windowsSetup.sha256) {
        problems.push(`${stage.windowsSetup.file} of the release marked Latest (${latest.tag_name}) has SHA-256 ${got}, not ${stage.windowsSetup.sha256} as the stage file says.`);
      }
    }
  }

  for (const url of urls) {
    const kind = addressKind(url);
    const r = await request("GET", url, { raw: true, accept: "*/*" });
    if (!r.ok) {
      problems.push(`${url} said ${r.status}, so a stranger reading ${ADDRESSES[kind].what} there gets nothing.`);
      continue;
    }
    const got = sha256Of(r.bytes);
    if (kind === "windows") {
      log(`  ${url} finally served ${r.url} (${r.bytes.length} bytes, SHA-256 ${got.slice(0, 12)}).`);
      if (got !== stage.windowsSetup.sha256) {
        problems.push(`${url} finally served ${r.url}, whose SHA-256 is ${got}, not the stage file's ${stage.windowsSetup.sha256}.`);
      }
      continue;
    }
    const want = await out.fileAt(PUBLIC_STAGE, ADDRESSES[kind].file);
    if (!want) {
      problems.push(`${ADDRESSES[kind].file} could not be read at ${PUBLIC_STAGE}, so what ${url} serves cannot be compared with it.`);
      continue;
    }
    log(`  ${url} finally served ${r.url} (${r.bytes.length} bytes, first line: ${firstLine(r.bytes)}).`);
    if (got !== sha256Of(want)) {
      problems.push(`${url} finally served ${r.url}, which is not ${ADDRESSES[kind].file} of ${PUBLIC_STAGE} (it served ${r.bytes.length} bytes whose first line is "${firstLine(r.bytes)}" and whose SHA-256 is ${got}).`);
    }
  }
  return problems;
}

export async function isPrivateRepo(api, ownerRepo) {
  const r = await api("GET", `/repos/${ownerRepo}`);
  if (!r.ok) refuse(`GitHub said ${r.status} to reading ${ownerRepo}${said(r)}.`);
  return !!r.json.private;
}

// The keys a step this repository hands over to someone else must not see: the two Apps' private
// keys, and any GitHub token of the maintainer's own that happens to be in this window
// (a builder is started without them). The website step
// deploys pages; it has no business with the keys that move the public stage.
const KEYS = /^(GODSPEED_(BUILDER|RELEASE)_APP_.*|GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i;

export function environmentWithoutKeys(env) {
  const out = {};
  const removed = [];
  for (const [k, v] of Object.entries(env)) {
    if (KEYS.test(k)) removed.push(k);
    else out[k] = v;
  }
  return { env: out, removed };
}

// The reporter the three self-tests print with, the same shape every self-test here uses.
export function reporter() {
  const state = { failures: 0 };
  return {
    ok(cond, name) {
      console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
      if (!cond) state.failures++;
    },
    get failures() {
      return state.failures;
    },
  };
}
