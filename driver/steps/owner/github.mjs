// The GitHub REST calls of the Forge's owner steps and requests, with one App token. Node's own fetch only.
// An error names the call and GitHub's answer, never the token.
export const DEFAULT_API = "https://api.github.com";

export class GithubError extends Error {
  constructor(method, path, status, message) {
    super(`GitHub answered ${status || "nothing"} to ${method} ${path}${message ? ` (${String(message).slice(0, 200)})` : ""}`);
    this.name = "GithubError";
    this.status = status;
    this.path = path;
    this.detail = String(message || "");
  }
}

// GitHub's refusal of a branch move by an App without the Workflows permission, when the move brings in changes
// under .github/workflows/ ("refusing to allow a GitHub App to create or update workflow `...` without
// `workflows` permission").
export const WORKFLOW_REFUSAL = /refusing to allow a GitHub App to create or update workflow|without [`'"]?workflows[`'"]? permission/i;
export const workflowRefusal = e => e instanceof GithubError && WORKFLOW_REFUSAL.test(e.detail);

export const apiBase = api => String(api || process.env.FORGE_GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, "");
export const repoPath = repository => {
  const [owner, name] = String(repository).split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};

// -> { request, get, post, patch, list }
//   request(method, path, body) -> { status, ok, json }   (throws GithubError only when GitHub cannot be reached)
//   get(path)                   -> json, or null for 404; throws GithubError otherwise
//   post/patch(path, body)      -> json; throws GithubError for any answer but 2xx
//   list(path, pages)           -> every row of a listing, 100 a page, at most `pages` pages
export function githubClient({ token, api, fetch: fetchImpl = globalThis.fetch } = {}) {
  const base = apiBase(api);
  async function request(method, path, body) {
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "godspeed-forge" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetchImpl(/^https?:/.test(path) ? path : base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new GithubError(method, path, 0, "GitHub could not be reached");
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, json };
  }
  const fail = (method, path, r) => new GithubError(method, path, r.status, r.json && r.json.message ? String(r.json.message) : "");
  return {
    request,
    async get(path) {
      const r = await request("GET", path);
      if (r.status === 404) return null;
      if (!r.ok) throw fail("GET", path, r);
      return r.json;
    },
    async post(path, body) {
      const r = await request("POST", path, body);
      if (!r.ok) throw fail("POST", path, r);
      return r.json;
    },
    async patch(path, body) {
      const r = await request("PATCH", path, body);
      if (!r.ok) throw fail("PATCH", path, r);
      return r.json;
    },
    async list(path, pages = 3) {
      const rows = [];
      const sep = path.includes("?") ? "&" : "?";
      for (let page = 1; page <= pages; page++) {
        const r = await request("GET", `${path}${sep}per_page=100&page=${page}`);
        if (r.status === 404) return rows;
        if (!r.ok) throw fail("GET", path, r);
        const got = Array.isArray(r.json) ? r.json : Array.isArray(r.json && r.json.check_runs) ? r.json.check_runs : [];
        rows.push(...got);
        if (got.length < 100) break;
      }
      return rows;
    },
  };
}

// Issues a pull request says it delivers or is the work for: "Closes #n", "Fixes #n", "Resolves #n", and the
// "Refs #n" a delivery carries until its final review (the pinned factory's .shared/workable.ts reads the same).
export function referencedIssues(body) {
  const text = String(body || "");
  const out = new Set();
  for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|relates? to|references?)\s+#(\d+)/gi)) out.add(Number(m[1]));
  return [...out];
}

// A ref's commit (branch `heads/<name>` or tag `tags/<name>`), following an annotated tag to its commit; null
// when the ref does not exist.
export async function refCommit(gh, repository, ref) {
  const r = await gh.get(`${repoPath(repository)}/git/ref/${ref.split("/").map(encodeURIComponent).join("/")}`);
  if (!r || !r.object) return null;
  if (r.object.type === "tag") {
    const t = await gh.get(`${repoPath(repository)}/git/tags/${r.object.sha}`);
    return t && t.object ? t.object.sha : null;
  }
  return r.object.sha;
}

// Points a branch at a commit: made when missing, moved (with force, never deleting anything) when there.
// ownerMove({ repository, branch, sha, exists }): how the branch is moved when GitHub refuses the App the move
// only because it brings in a change under .github/workflows/ (the Apps have no Workflows permission, on
// purpose): with the owner's own GitHub sign-in on this server (owner-gh.mjs). Tried once, for that refusal only;
// any other refusal is the App's failure as it is. -> the commit the branch pointed at before, or null when made.
export async function setBranch(gh, repository, branch, sha, { ownerMove } = {}) {
  const before = await refCommit(gh, repository, `heads/${branch}`);
  if (before === sha) return before;
  try {
    if (before === null) await gh.post(`${repoPath(repository)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    else await gh.patch(`${repoPath(repository)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { sha, force: true });
  } catch (e) {
    if (!ownerMove || !workflowRefusal(e)) throw e;
    await ownerMove({ repository, branch, sha, exists: before !== null });
  }
  return before;
}

// Makes a lightweight tag on a commit. -> 'made' | 'there' (already on that commit) | 'elsewhere' (the tag
// exists on another commit; nothing is changed).
export async function makeTag(gh, repository, tag, sha) {
  const at = await refCommit(gh, repository, `tags/${tag}`);
  if (at === sha) return "there";
  if (at) return "elsewhere";
  await gh.post(`${repoPath(repository)}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  return "made";
}
