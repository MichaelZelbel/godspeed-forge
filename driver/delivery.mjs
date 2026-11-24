// Where a ticket's work is on main when its issue was closed without a merged pull request that closes it (the Forge 0.3.1,
// ticket 03). The builder or release App may close such an issue with a comment that names the delivery:
//
//   "Delivered by https://github.com/<owner>/<repo>/pull/<N>"   (a pull request merged into main that names the issue)
//   "Already delivered on main by #<N> ..."                     (a pull request merged into main, or an issue closed by one)
//
// Godspeed 2.0.0-beta.31's ticket 01 (product issue #783) was closed with "Already delivered on main by #861 with #590 and
// #795"; #861 was an issue closed by the merged pull request #876. The release step and the driver both read these claims
// here, so they never disagree about whether a ticket is done. Only the Apps count: a person can register an App's name,
// but GitHub types his comment User, not Bot. Pure: the comments and the GraphQL answers come in, merges go out.

const esc = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A comment's author as both readers have it: GraphQL ({author: {login, __typename}}) or the REST shape the driver keeps
// ({author: "<login>", type: "Bot"}).
const loginOf = c => String((c && c.author && typeof c.author === "object" ? c.author.login : c && c.author) || "").replace(/\[bot\]$/, "");
const typeOf = c => (c && c.author && typeof c.author === "object" ? c.author.__typename : c && c.type) || "";
export const byApp = (c, apps) => (apps || []).map(a => String(a).replace(/\[bot\]$/, "")).includes(loginOf(c)) && typeOf(c) === "Bot";

// -> [{kind: "url" | "already", number}] the deliveries the Apps' comments name, newest comment last
export function deliveryClaims(comments, { repo, apps }) {
  const [owner, name] = String(repo || "").split("/");
  const url = new RegExp(String.raw`Delivered by https://github\.com/${esc(owner)}/${esc(name)}/pull/(\d+)`, "i");
  const out = [];
  for (const c of comments || []) {
    if (!byApp(c, apps)) continue;
    const body = String((c && c.body) || "");
    const u = url.exec(body);
    if (u) out.push({ kind: "url", number: Number(u[1]) });
    const a = /Already delivered on main by #(\d+)/i.exec(body);
    if (a) out.push({ kind: "already", number: Number(a[1]) });
  }
  return out;
}

// The GraphQL field that reads what an "Already delivered" claim names: a pull request, or an issue and what closed it.
export const ALREADY_NODE = "__typename ... on PullRequest { number merged mergedAt baseRefName headRefName body mergeCommit { oid } repository { nameWithOwner } } ... on Issue { number state closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number merged mergedAt baseRefName mergeCommit { oid } repository { nameWithOwner } } } }";
export const alreadyQuery = (repo, numbers) => {
  const [owner, name] = String(repo).split("/");
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${[...new Set(numbers)].map(n => `a${Number(n)}: issueOrPullRequest(number: ${Number(n)}) { ${ALREADY_NODE} }`).join(" ")} } }`;
};
const intoMain = (p, repo) => p && p.mergedAt && p.mergeCommit && p.mergeCommit.oid && p.baseRefName === "main" && (!p.repository || String(p.repository.nameWithOwner || "").toLowerCase() === String(repo).toLowerCase());
const merge = (p, repo) => ({ number: p.number, mergedAt: p.mergedAt, commit: p.mergeCommit.oid, repo, base: "main", viaComment: true });
// A "Delivered by <URL>" pull request must name the issue it delivers, in its body or its branch.
export const namesIssue = (pr, n, repo) => {
  const [owner, name] = String(repo).split("/");
  return new RegExp(String.raw`(?:^|[^\w])#${n}(?!\d)|github\.com/${esc(owner)}/${esc(name)}/issues/${n}(?!\d)`, "i").test(pr.body || "") ||
    new RegExp(String.raw`(?:^|[/_-])(?:issue-?)?${n}(?=$|[/_-])`).test(pr.headRefName || "");
};
// One "Already delivered on main by #N" claim against what GitHub says #N is. -> the merges it proves, newest first ([] for none)
export function alreadyMerges(node, repo) {
  if (!node) return [];
  if (node.__typename === "PullRequest") return intoMain(node, repo) ? [merge(node, repo)] : [];
  if (node.__typename === "Issue" && node.state === "CLOSED")
    return (((node.closedByPullRequestsReferences || {}).nodes) || []).filter(p => intoMain(p, repo)).map(p => merge(p, repo)).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  return [];
}
// Any claim against what GitHub says its number is: a "Delivered by <URL>" pull request merged into main that names the issue,
// or what alreadyMerges proves. -> the merges, newest first
export function claimMerges(claim, node, repo, issue) {
  if (claim.kind === "url") return node && node.__typename === "PullRequest" && intoMain(node, repo) && namesIssue(node, issue, repo) ? [merge(node, repo)] : [];
  return alreadyMerges(node, repo);
}
