// Moving the branch `staging` or `live` with the owner's own GitHub sign-in on this server, for the one case the
// release App may not: GitHub refuses an App without the Workflows permission a branch move that brings in changes
// under .github/workflows/, and neither Forge App gets that permission (a decision: an App key that can rewrite the
// project's own checks stays out of the factory's reach). Setup signs this server's `gh` in to GitHub with the
// `workflow` scope, so `gh api` as the account the Forge runs as can make the move. Used only through setBranch's
// ownerMove, only for that refusal; nothing else ever goes through the owner's sign-in.
import { execFile } from "node:child_process";
import { GithubError } from "./github.mjs";

// -> ownerMove({ repository, branch, sha, exists }) for setBranch. gh: the gh command (the Forge config's
// commands.gh, default gh). It runs without blocking, so the Forge keeps answering while gh works.
export function ownerBranchMove(gh = "gh") {
  return ({ repository, branch, sha, exists }) => new Promise((resolve, reject) => {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const args = exists
      ? ["api", "-X", "PATCH", `repos/${repository}/git/refs/heads/${ref}`, "-f", `sha=${sha}`, "-F", "force=true"]
      : ["api", "-X", "POST", `repos/${repository}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`];
    execFile(gh, args, { encoding: "utf8", timeout: 120000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => {
      if (!error) return resolve();
      const said = String(stderr || "").trim().split("\n").pop() || (typeof error.code === "string" ? `gh could not run (${error.code})` : `gh exited ${error.code}`);
      reject(new GithubError(exists ? "PATCH" : "POST", `/repos/${repository}/git/refs (the owner's own sign-in)`, 0, said));
    });
  });
}
