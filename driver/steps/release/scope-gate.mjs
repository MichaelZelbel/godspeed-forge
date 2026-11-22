// The approved release's ticket files are the freeze checklist. A deferral is a separate,
// reviewable decision, never an inference from a status note or an old request to hurry.
import path from "node:path";
import * as R from "./release-api.mjs";
import * as G from "./staging.mjs";
import { readDeferrals, leavesSomething } from "./scope-amendment.mjs";
import { checkFeasibility } from "./feasibility.mjs";

export async function checkScope(records, ownerRepo, version, candidateCommit, isMerged, release = null) {
  if (!G.underProcess(ownerRepo)) return;
  const id = records.findRelease(ownerRepo, version, release);
  const plan = records.read(`releases/${id}/plan.md`) || "";
  if (!/^status:\s*approved\b/im.test(plan)) R.refuse(`${id} has no approved release plan, so it cannot be frozen.`);
  const files = records.ticketFiles(id);
  if (/^## Tickets\s*$/im.test(plan) && !files.length) R.refuse(`${id} names tickets but has no ticket files, so it cannot be frozen.`);
  // the backstop of the feasibility gate (feasibility.mjs): a plan approved since it exists and still carrying a feature
  // ticket that names no source and no proof is not frozen
  const gate = checkFeasibility(plan, files.map((file) => ({ name: path.basename(file), text: records.read(file) || "" })));
  if (!gate.ok) R.refuse(`${id} has feature tickets that do not say what they are built with and what proves them, so it cannot be frozen. ${gate.problems.join(" ")}`);
  const open = [];
  for (const file of files) {
    const body = records.read(file) || "";
    const done = body.match(/^Status:\s*done\b.*\bmerge\s+([0-9a-f]{40})\b/im);
    const repository = body.match(/^Repository:\s*([^\s]+)(?:\s|$)/im)?.[1]?.replace(/[.,;:]+$/, "") || ownerRepo;
    if (!done || !(await isMerged(repository, done[1], repository.toLowerCase() === ownerRepo.toLowerCase() ? candidateCommit : "main"))) {
      open.push(path.basename(file));
    }
  }
  if (!open.length) return;
  const { deferred, problems, byDriver } = readDeferrals(records.json(`releases/${id}/scope-amendment.json`), { id, version, plan, ticketNames: files });
  const leaves = !byDriver || leavesSomething(deferred, files);
  const stands = deferred.every((name) => open.includes(name)) && leaves;
  const missing = open.filter((name) => !deferred.includes(name));
  if (!stands || missing.length) {
    const why = !leaves ? " Moving every ticket out would leave nothing to release." : problems.length ? ` ${problems.map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}.`).join(" ")}` : deferred.some((n) => !open.includes(n)) ? " A ticket named as moved out is already finished or unknown." : "";
    R.refuse(`${id} still has open approved-plan tickets (${open.join(", ")}). Freeze needs their verified merge status or an approved scope-amendment.json naming each deferred ticket; nothing was written.${why}`);
  }
}
