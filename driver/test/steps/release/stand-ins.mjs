// The stand-ins the three release commands run their --self-test against, all in the test's own
// process: GitHub's API with its branches, tags,
// commits, trees, blobs and releases; the raw host a stranger reads a public file from; the ghcr
// registry; the website addresses --read-back names; and a stand-in token script whose tokens say
// which App asked for them. Node's own modules only.
//
// Every request is recorded with its Authorization header, so a self-test can prove which identity
// each step used and that a dry run wrote nothing. Nothing here talks to the network.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// stage.schema.json of MichaelZelbel/godspeed-mission-control (ticket 1), with the long comments
// dropped: the rules a stage file this repository writes must pass. It is kept here exactly as the
// product's main holds it, the release tag's pattern included: since ticket 1b that pattern allows
// a tag of two parts joined by one slash, which is what candidate/<version> needs.
export const STAGE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "stage",
  description: "an object",
  type: "object",
  additionalProperties: false,
  neverNamedFields: {
    title: "the names a stage file never gives a field",
    names: [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__defineGetter__",
      "__defineSetter__",
      "__lookupGetter__",
      "__lookupSetter__",
    ],
  },
  required: ["stageFormat", "version", "productCommit", "kitBootstrap", "serverEditions", "windowsSetup", "addons", "previous", "withdrawn"],
  properties: {
    stageFormat: { title: "stage format", description: "1", const: 1 },
    version: { title: "version", description: "a version like 2.0.0-beta.6", type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$" },
    productCommit: { title: "product commit", description: "a 40-character commit", type: "string", pattern: "^[0-9a-f]{40}$" },
    kitBootstrap: {
      title: "kit bootstrap",
      description: "an object",
      type: "object",
      additionalProperties: false,
      required: ["unixEngineCommit", "windowsBootstrapCommit"],
      properties: {
        unixEngineCommit: { title: "shared Unix engine commit", description: "a 40-character commit", type: "string", pattern: "^[0-9a-f]{40}$" },
        windowsBootstrapCommit: { title: "Windows bootstrap commit", description: "a 40-character commit", type: "string", pattern: "^[0-9a-f]{40}$" },
      },
    },
    serverEditions: {
      title: "server editions",
      description: "an object naming at least one edition",
      type: "object",
      minProperties: 1,
      additionalProperties: false,
      patternProperties: {
        "^[a-z0-9]+(-[a-z0-9]+)*$": {
          title: "server edition {}",
          description: "an object",
          type: "object",
          additionalProperties: false,
          required: ["image"],
          properties: {
            image: {
              title: "server image of the {} edition",
              description: "pinned by digest",
              type: "string",
              pattern: "^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$",
            },
          },
        },
      },
    },
    windowsSetup: {
      title: "Windows setup",
      description: "an object",
      type: "object",
      additionalProperties: false,
      required: ["file", "releaseTag", "sha256"],
      properties: {
        file: { title: "Windows setup file name", description: "a file name", type: "string", minLength: 1, pattern: "^[A-Za-z0-9._-]+$" },
        releaseTag: { title: "Windows setup release tag", description: "a GitHub release tag", type: "string", minLength: 1, pattern: "^(?!.*\\.\\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$" },
        sha256: { title: "Windows setup SHA-256", description: "a 64-character SHA-256", type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
    addons: {
      title: "add-ons",
      description: "an object",
      type: "object",
      additionalProperties: false,
      patternProperties: { "^[a-z0-9]+(-[a-z0-9]+)*$": { title: "pin of the add-on {}", description: "a 40-character commit", type: "string", pattern: "^[0-9a-f]{40}$" } },
    },
    previous: {
      title: "previous stage",
      description: "null, or the stage this one replaced",
      type: ["null", "object"],
      additionalProperties: false,
      required: ["version", "stageCommit"],
      properties: {
        version: { title: "previous version", description: "a version like 2.0.0-beta.6", type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$" },
        stageCommit: { title: "previous stage commit", description: "a 40-character commit", type: "string", pattern: "^[0-9a-f]{40}$" },
      },
    },
    withdrawn: {
      title: "withdrawn list",
      description: "a list of versions",
      type: "array",
      items: { title: "withdrawn version", description: "a version", type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$" },
    },
  },
};

// A freeze writes the Windows setup's release tag as candidate/<version> (ticket 5), and the
// schema above allows it, because ticket 1b widened that one rule in the product. A commit older
// than ticket 1b still carries the narrower rule, and a stage file that rule refuses is one the
// product's own readers refuse as well, so no installer could install such a candidate. Freeze
// therefore reads the schema at the commit it freezes before it writes anything, and refuses in one
// plain sentence when the tag it would name is a tag that schema does not allow. It never falls
// back to a second tag: there is one tag, candidate/<version>, the one a ruleset protects. This is
// the schema of such an older commit, and the self-test that drives that refusal is its only user.
export const SCHEMA_REFUSING_SLASH_TAG = {
  ...STAGE_SCHEMA,
  properties: {
    ...STAGE_SCHEMA.properties,
    windowsSetup: {
      ...STAGE_SCHEMA.properties.windowsSetup,
      properties: {
        ...STAGE_SCHEMA.properties.windowsSetup.properties,
        releaseTag: { ...STAGE_SCHEMA.properties.windowsSetup.properties.releaseTag, pattern: "^[A-Za-z0-9._-]+$" },
      },
    },
  },
};

// ---------- the world the stand-ins serve ----------

export function makeWorld() {
  return {
    repos: {},
    registry: {},
    calls: [],
    rawFiles: {}, // "<ref>/<path>" -> what the raw host serves instead of the ref's own file
    rawFilesOnce: {}, // the same, served once and then forgotten: a copy that was still cached
    refSeen: {}, // "heads/beta" -> the commit an outside reader is told, instead of the real one
    site: {}, // "install" | "server" | "windows" -> what that address serves instead
    nextId: 1,
  };
}

const newSha = (w, seed) => sha1(`${seed}:${w.nextId++}`);

export function addRepo(w, ownerRepo, { isPrivate = false } = {}) {
  w.repos[ownerRepo] = { ownerRepo, private: isPrivate, default_branch: "main", refs: {}, commits: {}, trees: {}, blobs: {}, releases: [] };
  return w.repos[ownerRepo];
}

export function addCommit(w, ownerRepo, { files, parents = [], message = "a commit" }) {
  const repo = w.repos[ownerRepo];
  const tree = {};
  for (const [p, content] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = sha1(`blob:${bytes.toString("base64")}`);
    repo.blobs[sha] = bytes;
    tree[p] = sha;
  }
  const treeSha = newSha(w, "tree");
  repo.trees[treeSha] = tree;
  const sha = newSha(w, "commit");
  repo.commits[sha] = { sha, parents, tree: treeSha, message };
  return sha;
}

// A commit that is only known to exist (kit-bootstrap's two commits).
export function addKnownCommit(w, ownerRepo, sha) {
  const repo = w.repos[ownerRepo];
  const treeSha = newSha(w, "tree");
  repo.trees[treeSha] = {};
  repo.commits[sha] = { sha, parents: [], tree: treeSha, message: "a commit" };
  return sha;
}

export function addRelease(w, ownerRepo, { tag, draft = false, prerelease = false, latest = false, assets = {}, name = tag, body = "" }) {
  const repo = w.repos[ownerRepo];
  const release = {
    id: w.nextId++,
    tag_name: tag,
    name,
    body,
    draft,
    prerelease,
    latest,
    assets: Object.entries(assets).map(([name, content]) => ({ id: w.nextId++, name, bytes: Buffer.isBuffer(content) ? content : Buffer.from(content) })),
  };
  repo.releases.push(release);
  return release;
}

export const filesAt = (repo, commitSha) => {
  const commit = repo.commits[commitSha];
  if (!commit) return null;
  const tree = repo.trees[commit.tree] || {};
  const out = {};
  for (const [p, blob] of Object.entries(tree)) out[p] = repo.blobs[blob];
  return out;
};

const resolve = (repo, ref) => {
  if (repo.commits[ref]) return ref;
  for (const name of [`heads/${ref}`, `tags/${ref}`, ref]) {
    if (repo.refs[name]) return repo.refs[name];
  }
  return null;
};

const ancestors = (repo, sha, seen = new Set()) => {
  if (!sha || seen.has(sha)) return seen;
  seen.add(sha);
  for (const p of (repo.commits[sha] || { parents: [] }).parents) ancestors(repo, p, seen);
  return seen;
};

// What one commit changed against its first parent.
const changedIn = (repo, sha) => {
  const commit = repo.commits[sha];
  const tree = repo.trees[commit.tree] || {};
  const parent = commit.parents[0] ? repo.trees[repo.commits[commit.parents[0]].tree] || {} : {};
  const names = new Set([...Object.keys(tree), ...Object.keys(parent)]);
  return [...names].filter((n) => tree[n] !== parent[n]).sort();
};

// ---------- the stand-in servers, all on one port, one prefix each ----------

export async function startStandIns(w) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      w.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
      let answer;
      try {
        answer = route(w, req, raw, `http://127.0.0.1:${server.address().port}`);
      } catch (e) {
        answer = { status: 500, json: { message: `the stand-in broke: ${e.message}` } };
      }
      if (!answer) answer = { status: 404, json: { message: "Not Found" } };
      for (const [k, v] of Object.entries(answer.headers || {})) res.setHeader(k, v);
      res.statusCode = answer.status;
      if (answer.bytes) {
        res.end(answer.bytes);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(answer.json === undefined ? {} : answer.json));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    urls: { api: `${base}/api`, upload: `${base}/uploads`, raw: `${base}/raw`, ghcr: `${base}/ghcr`, site: `${base}/site` },
    close: () => new Promise((r) => server.close(r)),
  };
}

function route(w, req, body, base) {
  const [pathname, search] = req.url.split("?");
  const query = new URLSearchParams(search || "");
  const json = body.length && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body.toString("utf8")) : null;
  if (pathname.startsWith("/api/")) return api(w, req, pathname.slice(4), query, json, base);
  if (pathname.startsWith("/uploads/")) return upload(w, pathname.slice(8), query, body);
  if (pathname.startsWith("/raw/")) return rawHost(w, pathname.slice(4));
  if (pathname.startsWith("/ghcr/")) return registry(w, pathname.slice(5));
  if (pathname.startsWith("/site/")) return site(w, pathname.slice(5), base);
  return null;
}

function api(w, req, p, query, body, base) {
  const m = (re) => p.match(re);
  const found = (owner, name) => w.repos[`${owner}/${name}`];
  let g;

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    return repo ? { status: 200, json: { full_name: repo.ownerRepo, private: repo.private, default_branch: repo.default_branch } } : null;
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.(.+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const a = resolve(repo, decodeURIComponent(g[3]));
    const b = resolve(repo, decodeURIComponent(g[4]));
    if (!a || !b) return { status: 404, json: { message: "Not Found" } };
    const status = a === b ? "identical" : ancestors(repo, b).has(a) ? "ahead" : ancestors(repo, a).has(b) ? "behind" : "diverged";
    return { status: 200, json: { status } };
  }

  // A branch's commits, newest first along first parents, as GET /commits?sha=<branch> lists them.
  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/commits$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    if (w.githubLimited) return { status: 403, json: { message: "API rate limit exceeded" } };
    const list = [];
    for (let sha = resolve(repo, query.get("sha") || repo.default_branch); sha && list.length < Number(query.get("per_page") || 30); sha = (repo.commits[sha] || { parents: [] }).parents[0]) {
      list.push({ sha });
    }
    return { status: 200, json: list };
  }

  // The check runs on one commit, filtered by name as GitHub filters them.
  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    if (w.githubLimited) return { status: 403, json: { message: "API rate limit exceeded" } };
    const runs = ((repo.checkRuns || {})[g[3]] || []).filter((r) => !query.get("check_name") || r.name === query.get("check_name"));
    return { status: 200, json: { total_count: runs.length, check_runs: runs } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const sha = resolve(repo, decodeURIComponent(g[3]));
    if (!sha) return { status: 404, json: { message: "No commit found" } };
    return { status: 200, json: { sha, files: changedIn(repo, sha).map((f) => ({ filename: f })) } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const commit = repo.commits[g[3]];
    return commit ? { status: 200, json: { sha: commit.sha, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) } } : { status: 404, json: { message: "Not Found" } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/matching-refs\/(.*)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const prefix = decodeURIComponent(g[3]);
    const refs = Object.keys(repo.refs)
      .filter((r) => r.startsWith(prefix))
      .sort()
      .map((r) => ({ ref: `refs/${r}`, object: { sha: repo.refs[r], type: "commit" } }));
    return { status: 200, json: refs };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/(.+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const ref = decodeURIComponent(g[3]);
    const anonymous = !req.headers.authorization;
    const sha = (anonymous && w.refSeen[ref]) || repo.refs[ref];
    if (!sha) return { status: 404, json: { message: "Not Found" } };
    return { status: 200, json: { ref: `refs/${ref}`, object: { sha, type: "commit" } } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const file = decodeURIComponent(g[3]);
    if (w.contentsStatus && w.contentsStatus[file]) return { status: w.contentsStatus[file], json: { message: "injected" } };
    const sha = resolve(repo, query.get("ref") || repo.default_branch);
    const files = sha ? filesAt(repo, sha) : null;
    if (!files || !files[file]) return { status: 404, json: { message: "Not Found" } };
    return { status: 200, json: { name: path.basename(file), path: file, sha: sha1(files[file].toString("base64")), encoding: "base64", content: files[file].toString("base64") } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/)) && req.method === "POST") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const bytes = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
    const sha = sha1(`blob:${bytes.toString("base64")}`);
    repo.blobs[sha] = bytes;
    return { status: 201, json: { sha } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/)) && req.method === "POST") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const tree = { ...(repo.trees[body.base_tree] || {}) };
    for (const entry of body.tree) tree[entry.path] = entry.sha;
    const sha = newSha(w, "tree");
    repo.trees[sha] = tree;
    return { status: 201, json: { sha } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/)) && req.method === "POST") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const sha = newSha(w, "commit");
    repo.commits[sha] = { sha, parents: body.parents || [], tree: body.tree, message: body.message };
    return { status: 201, json: { sha } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/)) && req.method === "POST") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const ref = String(body.ref).replace(/^refs\//, "");
    if (repo.refs[ref]) return { status: 422, json: { message: "Reference already exists" } };
    repo.refs[ref] = body.sha;
    return { status: 201, json: { ref: body.ref, object: { sha: body.sha, type: "commit" } } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/)) && req.method === "PATCH") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const ref = decodeURIComponent(g[3]);
    if (!repo.refs[ref]) return { status: 404, json: { message: "Not Found" } };
    repo.refs[ref] = body.sha;
    return { status: 200, json: { ref: `refs/${ref}`, object: { sha: body.sha, type: "commit" } } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/releases$/)) && req.method === "POST") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const release = addRelease(w, repo.ownerRepo, { tag: body.tag_name, draft: !!body.draft, prerelease: !!body.prerelease, latest: body.make_latest === "true" });
    release.name = body.name || body.tag_name;
    release.body = body.body || "";
    release.target_commitish = body.target_commitish || null;
    return { status: 201, json: releaseJson(repo, release, base) };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/(.+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const tag = decodeURIComponent(g[3]);
    const release = repo.releases.find((r) => r.tag_name === tag);
    return release ? { status: 200, json: releaseJson(repo, release, base) } : { status: 404, json: { message: "Not Found" } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const release = repo.releases.find((r) => r.latest && !r.draft);
    return release ? { status: 200, json: releaseJson(repo, release, base) } : { status: 404, json: { message: "Not Found" } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    for (const release of repo.releases) {
      const asset = release.assets.find((a) => a.id === Number(g[3]));
      if (asset) return { status: 200, bytes: asset.bytes, headers: { "Content-Type": "application/octet-stream" } };
    }
    return { status: 404, json: { message: "Not Found" } };
  }

  // The artifacts of a repository, filtered by name as GitHub filters them.
  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/actions\/artifacts$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const list = (repo.artifacts || []).filter((a) => !query.get("name") || a.name === query.get("name"));
    return { status: 200, json: { total_count: list.length, artifacts: list } };
  }

  // The jobs of one run.
  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/jobs$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const r = (repo.runs || []).find((x) => x.id === Number(g[3]));
    if (!r || !r.jobs) return { status: 404, json: { message: "Not Found" } };
    return { status: 200, json: { total_count: r.jobs.length, jobs: r.jobs } };
  }

  // One run, by its id.
  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    if (w.runsLimited) return { status: 403, json: { message: "API rate limit exceeded" } };
    const r = (repo.runs || []).find((x) => x.id === Number(g[3]));
    if (!r) return { status: 404, json: { message: "Not Found" } };
    if (r.pollsLeft > 0 && --r.pollsLeft === 0) Object.assign(r, { status: "completed", conclusion: r.result });
    const { workflow, pollsLeft, result, jobs, ...json } = r;
    return { status: 200, json };
  }

  // The runs of one workflow, filtered by branch and event as GitHub filters them.
  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/runs$/)) && req.method === "GET") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const runs = (repo.runs || []).filter(
      (r) => r.workflow === decodeURIComponent(g[3]) && (!query.get("branch") || r.head_branch === query.get("branch")) && (!query.get("event") || r.event === query.get("event")),
    );
    // A run that finishes after it was looked at a few times, as a real one does while it is waited for.
    for (const r of runs) {
      if (r.pollsLeft > 0 && --r.pollsLeft === 0) Object.assign(r, { status: "completed", conclusion: r.result });
    }
    return { status: 200, json: { total_count: runs.length, workflow_runs: runs.map(({ workflow, pollsLeft, result, jobs, ...r }) => r) } };
  }

  if ((g = m(/^\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)$/)) && req.method === "PATCH") {
    const repo = found(g[1], g[2]);
    if (!repo) return null;
    const release = repo.releases.find((r) => r.id === Number(g[3]));
    if (!release) return { status: 404, json: { message: "Not Found" } };
    const wasDraft = release.draft;
    if ("draft" in body) release.draft = !!body.draft;
    if ("prerelease" in body) release.prerelease = !!body.prerelease;
    if (!w.ignoreReleaseText && typeof body.name === "string") release.name = body.name;
    if (!w.ignoreReleaseText && typeof body.body === "string") release.body = body.body;
    // Publishing a release whose tag does not exist yet makes the tag, on target_commitish, the
    // way GitHub does.
    if (wasDraft && !release.draft && !repo.refs[`tags/${release.tag_name}`]) {
      if (!release.target_commitish) return { status: 422, json: { message: "Published releases must have a valid tag" } };
      repo.refs[`tags/${release.tag_name}`] = resolve(repo, release.target_commitish) || release.target_commitish;
    }
    if (body.make_latest === "true") {
      for (const r of repo.releases) r.latest = false;
      release.latest = true;
    } else if (body.make_latest === "false") {
      release.latest = false;
    }
    return { status: 200, json: releaseJson(repo, release, base) };
  }

  return null;
}

function releaseJson(repo, release, base) {
  return {
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    make_latest: release.latest ? "true" : "false",
    html_url: `${base}/site/releases/${encodeURIComponent(release.tag_name)}`,
    upload_url: `${base}/uploads/repos/${repo.ownerRepo}/releases/${release.id}/assets{?name,label}`,
    assets: release.assets.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.bytes.length,
      url: `${base}/api/repos/${repo.ownerRepo}/releases/assets/${a.id}`,
      browser_download_url: `${base}/site/download/${encodeURIComponent(release.tag_name)}/${a.name}`,
    })),
  };
}

function upload(w, p, query, body) {
  const g = p.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/assets$/);
  if (!g) return null;
  const repo = w.repos[`${g[1]}/${g[2]}`];
  if (!repo) return null;
  const release = repo.releases.find((r) => r.id === Number(g[3]));
  if (!release) return { status: 404, json: { message: "Not Found" } };
  const name = query.get("name");
  // w.corruptUpload names a file that arrives at GitHub as something else, so a self-test can see
  // what freeze does when a checksum read back from the draft does not match.
  const bytes = w.corruptUpload === name ? Buffer.concat([body, Buffer.from(" and one byte more")]) : body;
  const asset = { id: w.nextId++, name, bytes };
  release.assets.push(asset);
  return { status: 201, json: { id: asset.id, name, size: bytes.length } };
}

// raw.githubusercontent.com: /<owner>/<repo>/<ref>/<path>
function rawHost(w, p) {
  const g = p.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!g) return null;
  const repo = w.repos[`${g[1]}/${g[2]}`];
  if (!repo) return null;
  const [, , , ref, file] = g;
  if (repo.private) return { status: 404, json: { message: "404: Not Found" } };
  const stale = w.rawFilesOnce[`${ref}/${file}`];
  if (stale !== undefined) {
    delete w.rawFilesOnce[`${ref}/${file}`];
    return { status: 200, bytes: Buffer.isBuffer(stale) ? stale : Buffer.from(stale), headers: { "Content-Type": "text/plain" } };
  }
  const override = w.rawFiles[`${ref}/${file}`];
  if (override !== undefined) return { status: 200, bytes: Buffer.isBuffer(override) ? override : Buffer.from(override), headers: { "Content-Type": "text/plain" } };
  const sha = resolve(repo, ref);
  const files = sha ? filesAt(repo, sha) : null;
  if (!files || !files[file]) return { status: 404, json: { message: "404: Not Found" } };
  return { status: 200, bytes: files[file], headers: { "Content-Type": "text/plain" } };
}

function registry(w, p) {
  if (p.startsWith("/token")) return { status: 200, json: { token: "anonymous-pull-token" } };
  const g = p.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
  if (!g) return null;
  const digest = (w.registry[g[1]] || {})[decodeURIComponent(g[2])];
  if (!digest) return { status: 404, json: { errors: [{ code: "MANIFEST_UNKNOWN" }] } };
  return {
    status: 200,
    bytes: Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [] })),
    headers: { "Content-Type": "application/vnd.oci.image.index.v1+json", "Docker-Content-Digest": digest },
  };
}

// The public website: the addresses --read-back names, and the download links releases carry.
function site(w, p, base) {
  let g = p.match(/^\/download\/([^/]+)\/(.+)$/);
  if (g) {
    const tag = decodeURIComponent(g[1]);
    for (const repo of Object.values(w.repos)) {
      const release = repo.releases.find((r) => r.tag_name === tag && !r.draft);
      const asset = release && release.assets.find((a) => a.name === g[2]);
      if (asset) return { status: 200, bytes: asset.bytes, headers: { "Content-Type": "application/octet-stream" } };
    }
    return { status: 404, json: { message: "Not Found" } };
  }
  g = p.match(/^\/(install|server|windows)$/);
  if (!g) return null;
  const which = g[1];
  const override = w.site[which];
  if (override !== undefined) {
    return { status: 200, bytes: Buffer.isBuffer(override) ? override : Buffer.from(override), headers: { "Content-Type": "text/plain" } };
  }
  if (which === "windows") {
    for (const repo of Object.values(w.repos)) {
      const release = repo.releases.find((r) => r.latest && !r.draft);
      const asset = release && release.assets.find((a) => /\.exe$/i.test(a.name));
      if (asset) return { status: 302, headers: { Location: `${base}/site/download/${encodeURIComponent(release.tag_name)}/${asset.name}` }, json: {} };
    }
    return { status: 404, json: { message: "Not Found" } };
  }
  const file = which === "install" ? "install-godspeed.sh" : "docker/server/install.sh";
  for (const repo of Object.values(w.repos)) {
    const sha = resolve(repo, "beta");
    const files = sha ? filesAt(repo, sha) : null;
    if (files && files[file]) return { status: 200, bytes: files[file], headers: { "Content-Type": "text/plain" } };
  }
  return { status: 404, json: { message: "Not Found" } };
}

// ---------- the stand-in token script, and the environment the commands run in ----------

export function writeTokenScript(dir) {
  const log = path.join(dir, "token-calls.txt");
  const script = path.join(dir, "stand-in-token.mjs");
  // Each token it hands out says which App asked for it, which call it was, and what it was
  // narrowed to, so a self-test can tell the token a command moved something with from the one it
  // read back with.
  fs.writeFileSync(
    script,
    `import fs from "node:fs"; const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);
fs.appendFileSync(log, argv.join(" ") + "\\n");
const n = fs.readFileSync(log, "utf8").trim().split("\\n").length;
const perms = (argv[argv.indexOf("--permissions") + 1] || "none").replace(/[^A-Za-z0-9]+/g, "_");
process.stdout.write("ghs_fake_" + argv[0] + "_" + n + "_" + perms);
`,
  );
  return {
    script,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []),
  };
}

// The maintainer's own tokens are in here on purpose: a self-test proves no step ever uses one.
export function standInEnv({ urls, tokenScript }) {
  return {
    ...process.env,
    RELEASE_TOKEN_SCRIPT: tokenScript,
    GITHUB_API_URL: urls.api,
    GITHUB_UPLOAD_URL: urls.upload,
    GITHUB_RAW_URL: urls.raw,
    GHCR_URL: urls.ghcr,
    RELEASE_READ_BACK_LOOKS: "1",
    RELEASE_READ_BACK_WAIT_MS: "10",
    GITHUB_TOKEN: "ghp_maintainer",
    GH_TOKEN: "gho_maintainer",
    GODSPEED_RELEASE_APP_ID: "456",
    GODSPEED_RELEASE_APP_KEY_B64: "c2VjcmV0",
  };
}

// Every token the stand-in token script was asked for was a release token, and every request the
// stand-ins saw carried either a release token or none at all (the reads from outside).
export function onlyReleaseTokens(w, tokens) {
  const askedRight = tokens.calls().every((line) => /^release \S+ --permissions \S+$/.test(line));
  const usedRight = w.calls.every((c) => c.auth === null || /^Bearer (ghs_fake_release_\d+_(contents_(read|write)|actions_read)|anonymous-pull-token)$/.test(c.auth));
  return askedRight && usedRight && !w.calls.some((c) => /maintainer/.test(String(c.auth)));
}

export const writes = (w) => w.calls.filter((c) => c.method !== "GET" && c.method !== "HEAD");

// The requests a command made after the last thing it changed: its reads from outside. Their
// Authorization header says which key read back, so a self-test can prove a read-back never
// carries the token the command moved something with.
export function readBackCalls(w) {
  let last = -1;
  w.calls.forEach((c, i) => {
    if (c.method !== "GET" && c.method !== "HEAD") last = i;
  });
  return w.calls.slice(last + 1);
}

// ---------- what the release step is holding when it freezes ----------

// A product repository as a freeze finds it: main with the last merged commit, beta on the stage
// commit of the version the public has today, that version's release marked Latest, the server
// image CI built for main's commit in the registry, and kit-bootstrap's two commits.
export function seedProduct(w, { ownerRepo = "Owner/Product", isPrivate = false, schema = STAGE_SCHEMA } = {}) {
  addRepo(w, ownerRepo, { isPrivate });
  addRepo(w, "MichaelZelbel/kit-bootstrap");

  const unixEngineCommit = sha1("unix-engine");
  const windowsBootstrapCommit = sha1("windows-bootstrap");
  const olderBootstrap = sha1("older-bootstrap");
  // The Unix engine commit the beta stage holds, which a freeze carries over when no
  // --kit-bootstrap names another. It is another commit than unixEngineCommit, so a self-test can
  // tell the carried one from an overriding one.
  const olderEngine = sha1("older-engine");
  addKnownCommit(w, "MichaelZelbel/kit-bootstrap", unixEngineCommit);
  addKnownCommit(w, "MichaelZelbel/kit-bootstrap", windowsBootstrapCommit);
  addKnownCommit(w, "MichaelZelbel/kit-bootstrap", olderBootstrap);
  addKnownCommit(w, "MichaelZelbel/kit-bootstrap", olderEngine);

  const imageName = "owner/product";
  const image = `ghcr.io/${imageName}`;
  const previousSetup = Buffer.from("the Windows setup of 2.0.0-beta.6");
  const previousReleaseTag = "godspeed-v2-integrated-2026-10-24-2";
  // One add-on the product carries itself, with no repository and so no commit of its own: its pin
  // is the product commit being frozen (freeze.mjs, and 2.0.0-beta.13's godspeed-charm, the first).
  const addonsAtMain = [
    { name: "godspeed-carried", carriedHere: true, license: "MIT", files: ["README.md"] },
    { name: "godspeed-coach", commit: sha1("coach-new"), license: "MIT", files: ["README.md"] },
    { name: "mc-phone", commit: sha1("phone-new"), license: "MIT", files: ["README.md"] },
  ];

  const betaStage = {
    stageFormat: 1,
    version: "2.0.0-beta.6",
    productCommit: sha1("beta6-product"),
    kitBootstrap: { unixEngineCommit: olderEngine, windowsBootstrapCommit: olderBootstrap },
    serverEditions: { server: { image: `${image}@sha256:${"a".repeat(64)}` } },
    windowsSetup: { file: "GodspeedSetup.exe", releaseTag: previousReleaseTag, sha256: sha256(previousSetup) },
    addons: { "godspeed-coach": sha1("coach-old"), "mc-phone": sha1("phone-old") },
    previous: null,
    withdrawn: ["2.0.0-beta.4"],
  };

  const common = {
    "stage.schema.json": `${JSON.stringify(schema, null, 2)}\n`,
    "install-godspeed.sh": "#!/usr/bin/env bash\n# the Mac and Linux line, reading its stage\n",
    "docker/server/install.sh": "#!/bin/sh\n# the Docker server line, reading its stage\n",
    "README.md": "# Godspeed Mission Control\n",
  };

  const betaCommit = addCommit(w, ownerRepo, {
    message: "The stage of 2.0.0-beta.6",
    files: { ...common, "stage.json": `${JSON.stringify(betaStage, null, 2)}\n`, "third-party/addons/sources.json": `${JSON.stringify([{ name: "godspeed-coach", commit: betaStage.addons["godspeed-coach"], license: "MIT", files: ["README.md"] }], null, 2)}\n` },
  });
  const mainCommit = addCommit(w, ownerRepo, {
    message: "The last ticket of the release",
    parents: [betaCommit],
    files: { ...common, "stage.json": `${JSON.stringify(betaStage, null, 2)}\n`, "third-party/addons/sources.json": `${JSON.stringify(addonsAtMain, null, 2)}\n` },
  });
  const repo = w.repos[ownerRepo];
  repo.refs["heads/main"] = mainCommit;
  repo.refs["heads/beta"] = betaCommit;

  addRelease(w, ownerRepo, { tag: previousReleaseTag, latest: true, assets: { "GodspeedSetup.exe": previousSetup } });

  const digest = `sha256:${"b".repeat(64)}`;
  w.registry[imageName] = { [`v2-sha-${mainCommit}`]: digest };

  return {
    ownerRepo,
    repo,
    mainCommit,
    betaCommit,
    betaStage,
    previousSetup,
    previousReleaseTag,
    image,
    imageName,
    digest,
    addonsAtMain,
    unixEngineCommit,
    windowsBootstrapCommit,
    olderEngine,
  };
}

// The add-on pins a freeze writes for a seeded product: the commit each add-on names, and the
// product commit itself for one the product carries (carriedHere, no commit of its own), in the
// order freeze writes them, by name.
export const addonPinsOf = (seed, productCommit = seed.mainCommit) =>
  Object.fromEntries(
    [...seed.addonsAtMain]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((a) => [a.name, a.commit || productCommit]),
  );

// The candidate a freeze left behind: the stage commit on top of main's commit, the tag on it, and
// its pre-release with the four files attached. What promote and take back find.
export function seedCandidate(w, seed, { version = "2.0.0-beta.7" } = {}) {
  const tag = `candidate/${version}`;
  const setup = Buffer.from(`the Windows setup of ${version}`);
  const stage = {
    stageFormat: 1,
    version,
    productCommit: seed.mainCommit,
    kitBootstrap: { unixEngineCommit: seed.unixEngineCommit, windowsBootstrapCommit: seed.windowsBootstrapCommit },
    serverEditions: { server: { image: `${seed.image}@${seed.digest}` } },
    windowsSetup: { file: "GodspeedSetup.exe", releaseTag: tag, sha256: sha256(setup) },
    addons: addonPinsOf(seed),
    previous: { version: seed.betaStage.version, stageCommit: seed.betaCommit },
    withdrawn: [...seed.betaStage.withdrawn],
  };
  const text = `${JSON.stringify(stage, null, 2)}\n`;
  const commit = addCommit(w, seed.ownerRepo, {
    parents: [seed.mainCommit],
    message: `Freeze ${version}: the stage file names what this candidate is made of`,
    files: { ...filesAt(seed.repo, seed.mainCommit), "stage.json": text },
  });
  seed.repo.refs[`tags/${tag}`] = commit;
  const release = addRelease(w, seed.ownerRepo, {
    tag,
    prerelease: true,
    name: `Godspeed ${version} (candidate)`,
    body: `The frozen candidate for ${version}.

It is not promoted. The public still gets what `+"`beta`"+` says.`,
    assets: { "GodspeedSetup.exe": setup, "windows-manifest.json": "{}\n", "SHA256SUMS": `${sha256(setup)}  GodspeedSetup.exe\n` },
  });
  return { version, tag, stage, text, commit, setup, release };
}

// One run of the product's scenarios workflow, started by hand (workflow_dispatch) on <branch> at
// <commit>: completed with conclusion <result> (success, failure, ...), or not completed yet when
// status says so (in_progress, queued); with pollsUntilDone, it completes with <result> on that
// listing of the runs. Its title is what the product's run-name makes of a stage that names the
// branch it ran on ("scenarios candidate/2.0.0-beta.7"), unless title says otherwise.
export function addScenarioRun(w, seed, { result = "success", status = "completed", pollsUntilDone, branch, commit, title, jobs, created = "2026-10-27T10:05:00Z" }) {
  const repo = seed.repo;
  const id = 40000000000 + w.nextId++;
  const waiting = pollsUntilDone > 0;
  (repo.runs ||= []).push({
    workflow: "scenarios.yml",
    id,
    event: "workflow_dispatch",
    head_branch: branch,
    head_sha: commit,
    display_title: title === undefined ? `scenarios ${branch}` : title,
    status: waiting ? "in_progress" : status,
    conclusion: !waiting && status === "completed" ? result : null,
    result,
    jobs,
    pollsLeft: waiting ? pollsUntilDone : 0,
    created_at: created,
    updated_at: created,
    html_url: `https://github.com/${seed.ownerRepo}/actions/runs/${id}`,
  });
  return id;
}

// main as follow-main.mjs reads it: one commit per entry, oldest first, each with the version its
// notebook/package.json says and its `required` check ("success", "failure", "in_progress", or
// null for none yet). Returns the commits, oldest first; main points at the last.
export function seedMain(w, ownerRepo, entries) {
  if (!w.repos[ownerRepo]) addRepo(w, ownerRepo);
  const repo = w.repos[ownerRepo];
  const shas = [];
  for (const [i, e] of entries.entries()) {
    const sha = addCommit(w, ownerRepo, {
      message: `main commit ${i}`,
      parents: shas.length ? [shas[shas.length - 1]] : [],
      files: { "notebook/package.json": `${JSON.stringify({ name: "godspeed-notebook", version: e.version }, null, 2)}\n`, "README.md": `# commit ${i}\n` },
    });
    shas.push(sha);
    if (e.required) {
      const done = e.required !== "in_progress";
      ((repo.checkRuns ||= {})[sha] = []).push({ id: w.nextId++, name: "required", status: done ? "completed" : "in_progress", conclusion: done ? e.required : null, started_at: `2026-10-27T1${i % 10}:00:00Z` });
    }
  }
  repo.refs["heads/main"] = shas[shas.length - 1];
  return shas;
}

// What a promote leaves behind: beta on the candidate's commit and its release marked Latest. What
// take back finds.
export function seedPromoted(w, seed, candidate) {
  seed.repo.refs[`heads/beta`] = candidate.commit;
  for (const r of seed.repo.releases) r.latest = false;
  const release = seed.repo.releases.find((r) => r.tag_name === candidate.tag);
  release.latest = true;
  release.prerelease = false;
  return candidate;
}

// ---------- the maintainer's server, and the records in godspeed-dev ----------

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_INSTANCE = "d3be7cc8af6f875f61613305";

// The add-ons' AI connection on the stand-in server (staging.mjs, addonAi): godspeed-model where the
// product's installer puts it, describing a configured AI and answering a one-word request. A test
// changes parts of it ({describe}, {ask: [first try, second try]}), names none ({command: ""}), or
// gives null for a server with no godspeed-model at all.
export const MODEL_COMMAND = "/root/godspeed/.godspeed/integrated-runtime/hermes/bin/godspeed-model";
export const modelSaid = (code, err, out = "") => ({ code, out, err });
export function addonAiState(o) {
  if (o === null) return { command: "" };
  return {
    command: MODEL_COMMAND,
    describe: modelSaid(0, "", JSON.stringify({ configured: true, provider: "openai-codex", model: "gpt-5.5" })),
    ask: [modelSaid(0, "", JSON.stringify({ text: "OK", provider: "openai-codex", model: "gpt-5.5" }))],
    ...(o || {}),
  };
}

// What the stand-in server (server-stand-in.mjs) starts from: the notebook healthy on
// <version>, and what an install there turns it into (installTo), unless the test says otherwise.
export function serverState(o = {}) {
  const now = o.now || "2026-10-27T10:00:00Z";
  return {
    now,
    host: "srv-stand-in",
    commit: o.commit || sha1("the product commit the server runs"),
    commitSince: o.commitSince || "2026-10-20T10:00:00Z",
    previous: "",
    stageRef: o.stageRef || "beta",
    installing: o.installing || 0,
    unreachable: !!o.unreachable,
    health:
      o.health === null
        ? null
        : { ok: true, format: 1, version: o.version || "2.0.0-beta.6", instance: SERVER_INSTANCE, scheduler_heartbeat: o.heartbeat || now, ...(o.health || {}) },
    installTo: { exit: 0, instance: SERVER_INSTANCE, ...(o.installTo || {}) },
    ...(o.tellExit !== undefined ? { tellExit: o.tellExit } : {}),
    ...(o.pinFails ? { pinFails: true } : {}),
    addonAi: addonAiState(o.addonAi),
    backup: "/root/godspeed/.godspeed/integrated-runtime/backups/20261027-100000-before",
    files: {},
    pollsBeforeDone: o.pollsBeforeDone || 2,
  };
}

// The stand-in for ssh: the environment that points the commands at it, what it holds now, and
// every call it answered.
export function writeSshStandIn(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, "server-state.json");
  const callsPath = path.join(dir, "server-calls.jsonl");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  fs.writeFileSync(callsPath, "");
  return {
    env: { STAGING_SSH_SCRIPT: path.join(HERE, "server-stand-in.mjs"), STAGING_STANDIN_STATE: statePath, STAGING_STANDIN_CALLS: callsPath },
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    set: (change) => fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), ...change }, null, 1)),
    calls: () =>
      fs
        .readFileSync(callsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

const gitRun = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout || "").trim();
};
const AS_TEST = ["-c", "user.name=Stand-in", "-c", "user.email=stand-in@example.invalid", "-c", "commit.gpgsign=false"];

// godspeed-dev as the records see it: a bare origin and a checkout of it, main holding one plan.md
// per release ({<release id>: <repository>}). RELEASE_RECORDS_ROOT points the commands at the
// checkout; json() reads a record the way promote does, from origin's main.
export function makeRecordsRepo(dir, releases = {}) {
  const origin = path.join(dir, "origin.git");
  const root = path.join(dir, "checkout");
  fs.mkdirSync(dir, { recursive: true });
  gitRun(["init", "-q", "--bare", "-b", "main", origin]);
  gitRun(["clone", "-q", origin, root], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# godspeed-dev, the stand-in\n");
  for (const [id, repo] of Object.entries(releases)) {
    fs.mkdirSync(path.join(root, "releases", id), { recursive: true });
    fs.writeFileSync(path.join(root, "releases", id, "plan.md"), `---\nrelease: ${id}\nrepository: ${repo}\nstatus: approved by Michael\n---\n\n# ${id}\n`);
  }
  gitRun(["-C", root, "add", "-A"]);
  gitRun(["-C", root, ...AS_TEST, "commit", "-q", "-m", "The releases"]);
  gitRun(["-C", root, "push", "-q", "origin", "HEAD:main"]);
  const show = (rel) => {
    const r = spawnSync("git", ["--git-dir", origin, "show", `main:${rel}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
  return {
    root,
    origin,
    show,
    json: (rel) => {
      const text = show(rel);
      return text === null ? null : JSON.parse(text);
    },
    // A record written straight onto origin's main, the way an earlier step left it.
    put(files) {
      const tmp = path.join(dir, `put-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      gitRun(["clone", "-q", origin, tmp], { stdio: "ignore" });
      for (const [rel, value] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
      }
      gitRun(["-C", tmp, "add", "-A"]);
      gitRun(["-C", tmp, ...AS_TEST, "commit", "-q", "-m", "An earlier record"]);
      gitRun(["-C", tmp, "push", "-q", "origin", "HEAD:main"]);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
    commits: () => Number(gitRun(["--git-dir", origin, "rev-list", "--count", "main"])),
  };
}

// The Windows setup GitHub built for one commit (the product's .github/workflows/windows-setup.yml):
// an artifact windows-setup-<commit> the stand-in GitHub lists, whose files the stand-in gh copies
// out of <root>/<run>/<name>.
export function addWindowsArtifact(w, seed, { root, commit, version, bootstrapCommit, expired = false }) {
  const run = 50000000000 + w.nextId++;
  const name = `windows-setup-${commit}`;
  const folder = writeWindowsFolder(path.join(root, String(run), name), { version, productCommit: commit, bootstrapCommit, setup: `the Windows setup GitHub built for ${commit}` });
  (seed.repo.artifacts ||= []).push({ id: w.nextId++, name, expired, created_at: "2026-10-27T11:00:00Z", workflow_run: { id: run, head_sha: commit, head_branch: "main" } });
  return { ...folder, run, name };
}

// The stand-in for gh (RELEASE_GH_SCRIPT): `run download <run> --repo <r> --name <n> --dir <d>`
// copies <root>/<run>/<n>/* into <d>, as gh does for the one artifact asked for. Every call is
// logged with the GH_TOKEN it carried.
export function writeGhStandIn(dir, root) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "gh-calls.jsonl");
  const script = path.join(dir, "stand-in-gh.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs"; import path from "node:path";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, token: process.env.GH_TOKEN || null }) + "\\n");
const opt = (k) => a[a.indexOf(k) + 1];
if (a[0] !== "run" || a[1] !== "download") { process.stderr.write("the stand-in gh knows only run download\\n"); process.exit(2); }
const from = path.join(${JSON.stringify(root)}, a[2], opt("--name"));
if (!fs.existsSync(from)) { process.stderr.write("no artifact matches any of the names or patterns provided\\n"); process.exit(1); }
for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(opt("--dir"), f));
`,
  );
  return {
    script,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

// The folder build-exe.sh writes for one commit.
export function writeWindowsFolder(dir, { version, productCommit, bootstrapCommit, setup = "the Windows setup of the candidate" }) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    channel: "full-alpha",
    version,
    kitCommit: productCommit,
    kitCommittedAt: "2026-10-25T10:00:00+02:00",
    bootstrapCommit,
    nodeVersion: "22.19.0",
    dataFormat: 1,
    files: [{ path: "kit/README.md", sha256: sha256("# Godspeed Mission Control\n") }],
  };
  const setupBytes = Buffer.from(setup);
  fs.writeFileSync(path.join(dir, "GodspeedSetup.exe"), setupBytes);
  fs.writeFileSync(path.join(dir, "windows-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "Godspeed-v2-integrated-source.tar.gz"), Buffer.from("the source archive of the candidate"));
  return { folder: dir, manifest, setupBytes, setupSha256: sha256(setupBytes) };
}
