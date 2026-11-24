#!/usr/bin/env node
// Freezes one candidate (process.md, section 2; the release step's role is roles/release.md).
//
//   node freeze.mjs <owner/repo> <version> --commit <sha> [--windows <folder>]
//        [--kit-bootstrap <sha>] [--dry-run]
//
// <sha> is the product commit to freeze: the release's last merged commit on main, or for a rebuilt
// candidate (2.0.0-beta.26.1) the head of the release branch release/2.0.0-beta.26 that auto-drive.mjs
// cut from the failed candidate's own commit (R.releaseBranch). The Windows
// setup of that commit (GodspeedSetup.exe, windows-manifest.json and the source archive) is the
// one GitHub built for it: the product's windows setup workflow runs build-exe.sh for every commit
// on main and keeps the three files as the artifact windows-setup-<sha>, which freeze downloads
// with gh into a folder of its own, with a release token narrowed to actions=read. --windows
// <folder> names a folder build-exe.sh wrote by hand instead. WHY (27 October 2026): the release
// step of 2.0.0-beta.8 failed three times when the setup had to be built by hand on X30.
//
// Neither the product at <sha> nor the Windows manifest names the commit of
// the bootstrap repository (the settings' releases.kit_bootstrap_repo) whose setup-godspeed.sh the Unix engine installs with: the installer
// reads it from the stage file, and the manifest names only the Windows bootstrap commit. So freeze
// carries it over from the stage the public has today, the one on beta, which is right for every
// release that does not change it. --kit-bootstrap <sha> names another one for the release that
// does. The Windows bootstrap commit is never asked for: the manifest names it.
//
// There is one tag, candidate/<version>: the stage commit carries it, the GitHub release is
// published on it, the stage file names it as the tag the Windows setup is published under, and a
// ruleset protects it. There is no second tag and no fallback to one. Whether a stage file may name
// that tag is the product's own rule, in stage.schema.json and in the same rule inside
// stage/stage.sh, and since ticket 1b it may. A commit older than that carries the narrower rule,
// and a stage file those readers refuse is one no installer can install the candidate from, so
// freeze reads that schema at <sha> before it writes anything and refuses in one plain sentence
// when the tag it would name is one that schema does not allow.
//
// In order, refusing with one plain sentence and writing nothing if a check fails: the commit is on
// main (or its release branch); the tag candidate/<version> does not exist; beta is there and its stage file says which
// version the public has today, which editions there are and which image each is built from; the
// server image v2-sha-<sha> of every edition is in the registry (ghcr.io, read anonymously); the
// Windows manifest names <sha> and <version> and the Windows bootstrap commit; the Unix engine's
// kit-bootstrap commit is known (carried from beta, or named with --kit-bootstrap) and both
// kit-bootstrap commits exist; the setup's SHA-256 is computed from the file; the pins are read at <sha>;
// and the stage that comes out of all this passes stage.schema.json as the product holds it at
// <sha>. Then one commit on top of <sha> whose only change is stage.json, the tag on it, a draft
// release with the four files attached, every checksum read back from the draft, and only then the
// release published as a pre-release that is not Latest. main is never touched.
//
// The token is always a release token for the one repository (scripts/gh-app-token.mjs release),
// narrowed to contents=write, and contents=read for a dry run, which therefore cannot write even
// if this script is wrong.
//
// Right after a freeze of the product (the main project's repository) that worked, it puts
// the candidate on the maintainer's own server (stage-server.mjs), so he has it the moment there is
// something to try, and promote.mjs later finds its record. A freeze of anything else, a rehearsal
// copy above all, puts nothing on his server; --no-staging skips it for the product too, and then
// stage-server.mjs is run by hand before the candidate can be made public.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import * as R from "./release-api.mjs";
import * as G from "./staging.mjs";
import { cfg, configureFromEnv } from "./config.mjs";
import { checkScope } from "./scope-gate.mjs";
import { stageServer } from "./stage-server.mjs";

export const THIS_FILE = fileURLToPath(import.meta.url);
export const SETUP = "GodspeedSetup.exe";
export const MANIFEST = "windows-manifest.json";
export const SUMS = "SHA256SUMS";
export const SOURCES = "third-party/addons/sources.json";
// The artifact the product's .github/workflows/windows-setup.yml keeps for every commit on main.
export const windowsArtifact = (commit) => `windows-setup-${commit}`;

export const USAGE = `usage:
  node freeze.mjs <owner/repo> <version> --commit <sha> [--windows <folder>] [--kit-bootstrap <sha>] [--no-staging] [--release <id>] [--dry-run]
  (the self-test is in the Forge's test folder)`;

// The install on the maintainer's server, right after the freeze (see the top of this file).
export async function stageAfterFreeze({ ownerRepo, version, release = null, noStaging, dryRun, env, log }) {
  const command = `node ${path.join(path.dirname(THIS_FILE), "stage-server.mjs")} ${ownerRepo} ${version}`;
  if (ownerRepo.toLowerCase() !== G.PRODUCT_REPO.toLowerCase()) {
    log(`${ownerRepo} is not ${G.PRODUCT_REPO}, so nothing is put on your server for it.`);
    return;
  }
  // The scenarios are started now, on the tag itself, so they run while the install does and he can
  // be asked the moment both are done (staging.mjs, scenarios; roles/release.md).
  const start = `gh workflow run ${G.SCENARIOS_WORKFLOW} --repo ${ownerRepo} --ref candidate/${version} -f stage=candidate/${version}`;
  if (!dryRun) log(`Start the scenarios now, from another shell, while this goes on: ${start}`);
  if (noStaging) {
    log(`--no-staging: ${version} is not put on your server now, and it cannot be made public before it is; run ${command} for that.`);
    return;
  }
  if (dryRun) {
    log(`Would then say to start the scenarios on the tag (${start}) and put it on your server: ${command} (its own --dry-run prints the exact commands).`);
    return;
  }
  log("");
  log(`Now putting ${version} on your server (${command}):`);
  try {
    await stageServer({ ownerRepo, version, release, dryRun: false, env, log: (s) => log(`  ${s}`) });
  } catch (e) {
    if (!(e instanceof R.Refused)) throw e;
    // The install can be done and recorded and the check right after find it not healthy.
    R.refuse(
      /was installed on your server, but/.test(e.message)
        ? `${version} is frozen. ${e.message} Run ${command} once that is fixed.`
        : `${version} is frozen, but it was not put on your server: ${e.message} Run ${command} once that is fixed.`,
    );
  }
}

// The Windows setup GitHub built for <commit>: the newest artifact windows-setup-<commit> that has
// not expired, from a run on that very commit, downloaded with gh (RELEASE_GH_SCRIPT, a Node script,
// stands in for it in the self-test) into a new folder. Returns that folder.
export async function windowsFromGitHub({ ownerRepo, commit, env, log }) {
  const token = R.mintToken(env, ownerRepo, "actions=read");
  const api = R.githubApi(token, env);
  const name = windowsArtifact(commit);
  const r = await api("GET", `/repos/${ownerRepo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`);
  if (!r.ok || !r.json || !Array.isArray(r.json.artifacts)) {
    R.refuse(`GitHub said ${r.status} to listing the artifacts of ${ownerRepo}, so the Windows setup built for ${commit.slice(0, 7)} cannot be found.`);
  }
  const named = r.json.artifacts.filter((a) => a.name === name && a.workflow_run && a.workflow_run.head_sha === commit);
  const live = named.filter((a) => !a.expired).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!live.length) {
    R.refuse(
      `GitHub holds no Windows setup built for commit ${commit.slice(0, 7)} (${named.length ? `the artifact ${name} has expired` : `no artifact ${name}`}): the product's windows setup workflow builds it for every commit on main, so wait for its run on that commit, or name a folder build-exe.sh wrote with --windows. Nothing was written.`,
    );
  }
  const artifact = live[0];
  const run = artifact.workflow_run.id;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-windows-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const [cmd, pre] = env.RELEASE_GH_SCRIPT ? [process.execPath, [env.RELEASE_GH_SCRIPT]] : ["gh", []];
  // gh reads GH_TOKEN before its own login, so the download carries the release token and nothing else.
  const ghEnv = { ...env, GH_TOKEN: token, GH_ENTERPRISE_TOKEN: "", GITHUB_TOKEN: "", GH_HOST: "github.com" };
  const p = spawnSync(cmd, [...pre, "run", "download", String(run), "--repo", ownerRepo, "--name", name, "--dir", dir], { encoding: "utf8", env: ghEnv, maxBuffer: 16 << 20 });
  if (p.error || p.status !== 0) {
    R.refuse(`The Windows setup built for ${commit.slice(0, 7)} (artifact ${name} of run ${run}) could not be downloaded: ${p.error ? p.error.message : (p.stderr || "").trim().split("\n").pop() || `gh exited ${p.status}`}. Nothing was written.`);
  }
  log(`  The Windows setup GitHub built for ${commit.slice(0, 7)} is the artifact ${name} of run ${run} (${artifact.created_at}); downloaded with a release token narrowed to actions=read.`);
  // gh puts the files of the one artifact asked for straight into --dir; a folder named after it is taken too.
  return fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : dir;
}

export function windowsFolder(folder) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) R.refuse(`There is no folder ${folder}, so the Windows setup cannot be read.`);
  const setup = path.join(folder, SETUP);
  const manifestFile = path.join(folder, MANIFEST);
  if (!fs.existsSync(setup)) R.refuse(`${folder} holds no ${SETUP}.`);
  if (!fs.existsSync(manifestFile)) R.refuse(`${folder} holds no ${MANIFEST}.`);
  const archives = fs.readdirSync(folder).filter((f) => /\.tar\.gz$/i.test(f));
  if (archives.length !== 1) R.refuse(`${folder} holds ${archives.length} source archives (one .tar.gz is wanted, the one build-exe.sh writes).`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (e) {
    R.refuse(`${manifestFile} is not JSON (${e.message}).`);
  }
  return { setup, manifestFile, manifest, archive: path.join(folder, archives[0]) };
}

export async function freeze({ ownerRepo, version, commit, windows, kitBootstrap, noStaging = false, releaseId = null, dryRun, env, log }) {
  const permissions = dryRun ? "contents=read" : "contents=write";
  const token = R.mintToken(env, ownerRepo, permissions);
  const api = R.githubApi(token, env);
  const anonymous = R.githubApi(null, env);
  const tag = `candidate/${version}`;
  log(`Freezing ${version} of ${ownerRepo} from commit ${commit.slice(0, 7)} as ${tag}${dryRun ? ". This is a dry run: it checks everything and writes nothing." : "."}`);
  log(`The key is a release token for ${ownerRepo} alone, narrowed to ${permissions}.`);

  if (!(await R.commitExists(api, ownerRepo, commit))) R.refuse(`There is no commit ${commit} in ${ownerRepo}.`);
  // A candidate comes from main, or, when a failed candidate was rebuilt without one change, from the
  // release's own branch (R.releaseBranch: cut from the failed candidate's commit, so main never has to
  // stand still while the rebuild's checks run).
  let from = "main";
  if (!(await R.reachableFrom(api, ownerRepo, commit, "main"))) {
    from = R.releaseBranch(version);
    if (!(await R.reachableFrom(api, ownerRepo, commit, from))) {
      R.refuse(`Commit ${commit} is neither on main of ${ownerRepo} nor on its release branch ${from}, and a candidate is frozen from a commit merged into one of the two.`);
    }
  }
  log(`  Commit ${commit.slice(0, 7)} is on ${from}.`);
  // A ticket in another repository is checked from outside first; when that repository is private
  // (beta.20's godspeed-workouts, 404 to a stranger), with a release token of its own narrowed to
  // contents=read, so a private ticket repository is verified rather than counted as open.
  // release: the folder under releases/ when the version is a re-freeze of it (2.0.0-beta.26.1 of the 2.0.0-beta.26 folder)
  await checkScope(new G.Records(env), ownerRepo, version, commit, async (repo, sha, tip) => {
    if (repo.toLowerCase() === ownerRepo.toLowerCase()) return R.reachableFrom(api, repo, sha, tip);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
    if (await R.reachableFrom(anonymous, repo, sha, tip)) return true;
    let readToken;
    try { readToken = R.mintToken(env, repo, "contents=read"); } catch { return false; } // no App there: the ticket stays open and is named
    const read = R.githubApi(readToken, env);
    const merged = await R.reachableFrom(read, repo, sha, tip);
    if (merged) log(`  ${repo} is not readable from outside; its ticket's merge ${sha.slice(0, 7)} was checked with a release token narrowed to contents=read.`);
    return merged;
  }, releaseId);

  if (await R.refSha(api, ownerRepo, `tags/${tag}`)) R.refuse(`${ownerRepo} already has the tag ${tag}, so ${version} was frozen before; nothing was written.`);
  log(`  There is no tag ${tag} yet.`);

  const betaSha = await R.refSha(api, ownerRepo, `heads/${R.PUBLIC_STAGE}`);
  if (!betaSha) {
    R.refuse(`${ownerRepo} has no ${R.PUBLIC_STAGE} branch, so the stage this candidate replaces cannot be named; create ${R.PUBLIC_STAGE} on the stage commit of the version the public has today first.`);
  }
  const beta = await R.readStageAt(api, ownerRepo, betaSha);
  if (!beta) R.refuse(`There is no ${R.STAGE_FILE} on ${R.PUBLIC_STAGE} of ${ownerRepo} (commit ${betaSha.slice(0, 7)}).`);
  log(`  ${R.PUBLIC_STAGE} holds ${beta.stage.version} on commit ${betaSha.slice(0, 7)}, withdrawn ${JSON.stringify(beta.stage.withdrawn || [])}.`);

  // The Unix engine's kit-bootstrap commit: no file of the product at <sha> names it and the
  // Windows manifest names only the Windows one, so it is carried over from the stage the public
  // has today unless --kit-bootstrap names another.
  const carriedKitBootstrap = (beta.stage.kitBootstrap || {}).unixEngineCommit;
  const unixEngineCommit = kitBootstrap || carriedKitBootstrap;
  if (!unixEngineCommit) {
    R.refuse(
      `The stage file on ${R.PUBLIC_STAGE} of ${ownerRepo} names no kitBootstrap.unixEngineCommit, so the commit of ${cfg.kitBootstrapRepo} this candidate installs with cannot be carried over from it; name it with --kit-bootstrap <sha>. Nothing was written.`,
    );
  }
  if (!R.COMMIT_PATTERN.test(String(unixEngineCommit))) {
    R.refuse(
      `The stage file on ${R.PUBLIC_STAGE} of ${ownerRepo} names kitBootstrap.unixEngineCommit as ${JSON.stringify(carriedKitBootstrap)}, which is not a 40-character commit, so it cannot be carried over; name the commit with --kit-bootstrap <sha>. Nothing was written.`,
    );
  }
  log(
    kitBootstrap
      ? `  The Unix engine installs with kit-bootstrap ${unixEngineCommit.slice(0, 7)}, as --kit-bootstrap names it${carriedKitBootstrap ? ` (${R.PUBLIC_STAGE} holds ${String(carriedKitBootstrap).slice(0, 7)}, so this release changes it)` : ""}.`
      : `  The Unix engine installs with kit-bootstrap ${unixEngineCommit.slice(0, 7)}, carried over from the ${R.PUBLIC_STAGE} stage, because no --kit-bootstrap names another.`,
  );

  const editions = Object.keys(beta.stage.serverEditions || {});
  if (!editions.length) R.refuse(`The stage file on ${R.PUBLIC_STAGE} of ${ownerRepo} names no server edition, so freeze does not know which image to look for.`);
  const serverEditions = {};
  const imageTag = `v2-sha-${commit}`;
  for (const edition of editions) {
    const image = String(beta.stage.serverEditions[edition].image).split("@")[0];
    const digest = await R.imageDigest(env, image, imageTag);
    if (!digest) {
      R.refuse(`The ${edition} image ${R.registryName(image)}:${imageTag} is not in the registry, so there is nothing to freeze; CI builds it for every commit on main.`);
    }
    serverEditions[edition] = { image: `${image}@${digest}` };
    log(`  The ${edition} image ${imageTag} is in the registry as ${digest}.`);
  }

  const win = windowsFolder(windows || (await windowsFromGitHub({ ownerRepo, commit, env, log })));
  if (win.manifest.kitCommit !== commit) {
    R.refuse(`${win.manifestFile} names ${win.manifest.kitCommit} as the product commit, not ${commit}, so that setup was built from another commit.`);
  }
  if (win.manifest.version !== version) {
    R.refuse(`${win.manifestFile} says version ${win.manifest.version}, not ${version}.`);
  }
  const windowsBootstrapCommit = String(win.manifest.bootstrapCommit || "");
  if (!R.COMMIT_PATTERN.test(windowsBootstrapCommit)) {
    R.refuse(`${win.manifestFile} names no Windows bootstrap commit (it says ${JSON.stringify(win.manifest.bootstrapCommit)}).`);
  }
  log(`  ${MANIFEST} names ${version}, product commit ${commit.slice(0, 7)} and Windows bootstrap commit ${windowsBootstrapCommit.slice(0, 7)}.`);

  for (const [what, sha] of [
    ["Unix engine", unixEngineCommit],
    ["Windows bootstrap", windowsBootstrapCommit],
  ]) {
    if (!(await R.commitExists(anonymous, cfg.kitBootstrapRepo, sha))) {
      R.refuse(`There is no commit ${sha} in ${cfg.kitBootstrapRepo}, so the ${what} commit cannot be named in the stage file.`);
    }
  }
  log(`  Both kit-bootstrap commits exist (${unixEngineCommit.slice(0, 7)} for the Unix engine, ${windowsBootstrapCommit.slice(0, 7)} for Windows).`);

  const setupSha256 = R.sha256File(win.setup);
  log(`  ${SETUP} is ${fs.statSync(win.setup).size} bytes, SHA-256 ${setupSha256}.`);

  const sourcesFile = await R.readFileAt(api, ownerRepo, SOURCES, commit);
  if (!sourcesFile) R.refuse(`There is no ${SOURCES} at ${commit} in ${ownerRepo}, so the carried add-on pins cannot be read.`);
  let carried;
  try {
    carried = JSON.parse(sourcesFile.text);
  } catch (e) {
    R.refuse(`${SOURCES} at ${commit} in ${ownerRepo} is not JSON (${e.message}).`);
  }
  if (!Array.isArray(carried)) R.refuse(`${SOURCES} at ${commit} in ${ownerRepo} is not a list of add-ons.`);
  // An add-on the product carries itself has no commit of its own: there is no repository to pin it
  // to, so `sources.json` says `"carriedHere": true` in place of a commit and its pin is the product
  // commit being frozen, because the product is its source. That is the rule 2.0.0-beta.13's ticket
  // 01 wrote down for godspeed-charm (pull request #111, "The stage file names it"), which is the
  // first such add-on; before this, freeze refused every candidate carrying one.
  const addons = {};
  let carriedHere = 0;
  for (const addon of [...carried].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (!addon || !addon.name) R.refuse(`An add-on in ${SOURCES} at ${commit} names no name.`);
    if (!addon.commit && addon.carriedHere !== true) {
      R.refuse(`The add-on ${addon.name} in ${SOURCES} at ${commit} names no commit and does not say "carriedHere": true, so there is nothing to pin it to.`);
    }
    if (addon.commit && addon.carriedHere === true) {
      R.refuse(`The add-on ${addon.name} in ${SOURCES} at ${commit} names a commit and says "carriedHere": true, and only one of the two can be its pin.`);
    }
    addons[addon.name] = addon.commit || commit;
    if (!addon.commit) carriedHere += 1;
  }
  log(`  ${Object.keys(addons).length} carried add-on(s) pinned as ${SOURCES} holds them at ${commit.slice(0, 7)}${carriedHere ? `, ${carriedHere} of them carried in the product itself and so pinned to that commit` : ""}.`);

  const stage = {
    stageFormat: 1,
    version,
    productCommit: commit,
    kitBootstrap: { unixEngineCommit, windowsBootstrapCommit },
    serverEditions,
    windowsSetup: { file: SETUP, releaseTag: tag, sha256: setupSha256 },
    addons,
    previous: { version: beta.stage.version, stageCommit: betaSha },
    withdrawn: [...(beta.stage.withdrawn || [])],
  };

  // There is one tag: the stage commit carries candidate/<version>, the release is published on it
  // and the stage file names it. Whether a stage file may name it is the product's own rule, in
  // stage.schema.json at this commit, which stage/stage.sh repeats; since ticket 1b it may. A stage
  // file that rule refuses is one no installer can read, so it is settled here, before anything is
  // written, and there is no second tag to fall back to.
  const schema = await R.readSchemaAt(api, ownerRepo, commit);
  const problems = R.checkStage(stage, schema, `the stage file for ${version}`);
  const aboutTag = problems.find((p) => p.includes("windowsSetup.releaseTag"));
  if (aboutTag) {
    R.refuse(
      `${aboutTag} ${R.SCHEMA_FILE} at ${commit.slice(0, 7)} in ${ownerRepo} does not allow the release tag ${tag}, and a stage file it refuses is one ${R.STAGE_FILE}'s own readers refuse as well, so nobody could install this candidate. That commit is older than ticket 1b, which let a release tag hold one slash in the product's ${R.SCHEMA_FILE} and in the same rule in stage/stage.sh; freeze a commit that has it. Nothing was written.`,
    );
  }
  if (problems.length) {
    R.refuse(`${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""} Nothing was written.`);
  }
  const text = R.stageText(stage);
  log(`  The stage passes ${R.SCHEMA_FILE} as ${ownerRepo} holds it at ${commit.slice(0, 7)}, and names ${tag} as the release the setup is published under.`);

  const body = [
    `The frozen candidate for ${version}: product commit ${commit}${from === "main" ? "" : ` on ${from}`}.`,
    "",
    "It is not promoted. The public still gets what `beta` says; this release is here so the",
    "scenarios, the maintainer's server and the maintainer himself can install exactly this build.",
    "This title and these notes are the freeze-time text: promoting the candidate replaces both with",
    "the public ones, so a promoted release never keeps them.",
    "",
    `Install this candidate with GODSPEED_STAGE_REF=${tag}.`,
  ].join("\n");

  if (dryRun) {
    log("");
    log(`Would write ${R.STAGE_FILE} as one commit on top of ${commit.slice(0, 7)}, tag it ${tag}, attach ${SETUP}, ${MANIFEST}, ${path.basename(win.archive)} and ${SUMS} to a draft release on ${tag}, read every checksum back, and publish it as a pre-release that is not Latest.`);
    log(`The ${R.STAGE_FILE} it would write:`);
    for (const line of text.trimEnd().split("\n")) log(`  | ${line}`);
    await stageAfterFreeze({ ownerRepo, version, release: releaseId, noStaging, dryRun: true, env, log });
    log("A dry run writes nothing, and its token could not have written anything.");
    return { stage, text, tag, dryRun: true };
  }

  const stageCommit = await R.commitOneFile(api, ownerRepo, {
    parent: commit,
    file: R.STAGE_FILE,
    text,
    message: `Freeze ${version}: the stage file names what this candidate is made of`,
  });
  const changed = await R.changedFiles(api, ownerRepo, stageCommit);
  if (changed.length !== 1 || changed[0] !== R.STAGE_FILE) {
    R.refuse(`Commit ${stageCommit} changed ${changed.join(", ") || "nothing"}, and a freeze commit changes ${R.STAGE_FILE} and nothing else.`);
  }
  log(`Wrote commit ${stageCommit.slice(0, 7)} on top of ${commit.slice(0, 7)}; its only change is ${R.STAGE_FILE}.`);

  await R.createRef(api, ownerRepo, `refs/tags/${tag}`, stageCommit);
  log(`Tagged it ${tag}. main is unchanged: main changes only through pull requests.`);

  const release = await R.createDraftRelease(api, ownerRepo, { tag, commit: stageCommit, name: `Godspeed ${version} (candidate)`, body });
  const files = [
    { name: SETUP, bytes: fs.readFileSync(win.setup) },
    { name: MANIFEST, bytes: fs.readFileSync(win.manifestFile) },
    { name: path.basename(win.archive), bytes: fs.readFileSync(win.archive) },
  ];
  const sums = R.sha256sumsText(files.map((f) => ({ name: f.name, sha256: R.sha256Of(f.bytes) })));
  files.push({ name: SUMS, bytes: Buffer.from(sums) });
  const attached = [];
  for (const file of files) {
    const asset = await R.uploadAsset(release, { name: file.name, bytes: file.bytes, token, env });
    attached.push({ ...file, id: asset.id });
    log(`  Attached ${file.name} (${file.bytes.length} bytes) to the draft release.`);
  }

  const readBack = {};
  for (const file of attached) {
    const bytes = await R.assetBytesWithToken(api, ownerRepo, file.id);
    const got = R.sha256Of(bytes);
    const want = R.sha256Of(file.bytes);
    if (got !== want) {
      R.refuse(`${file.name} read back from the draft release has SHA-256 ${got}, not ${want} as it was written, so the release is left unpublished: nothing is public.`);
    }
    readBack[file.name] = got;
    log(`  ${file.name} read back from the draft: SHA-256 ${got}, as written.`);
  }
  for (const line of readBack[SUMS] ? sums.trimEnd().split("\n") : []) {
    const [checksum, name] = line.split(/\s+/);
    if (readBack[name] !== checksum) {
      R.refuse(`${SUMS} says ${name} has SHA-256 ${checksum}, and the file read back from the draft release has ${readBack[name]}, so the release is left unpublished.`);
    }
  }
  log(`  ${SUMS} agrees with every file read back from the draft release.`);

  const published = await R.publishPreRelease(api, ownerRepo, release.id);
  if (published.draft || !published.prerelease || published.make_latest === "true") {
    R.refuse(`The release of ${tag} is draft=${published.draft}, prerelease=${published.prerelease}, latest=${published.make_latest}, and a candidate is a published pre-release that is not Latest.`);
  }
  log(`Published ${tag} as a pre-release, not Latest: ${published.html_url || "(no address)"}`);
  log(`${version} is frozen. The public still gets what ${R.PUBLIC_STAGE} says, until promote.mjs is run once it is healthy on your server, its scenarios passed, and you said "go".`);
  await stageAfterFreeze({ ownerRepo, version, release: releaseId, noStaging, dryRun: false, env, log });
  return { stage, text, tag, releaseTag: tag, stageCommit, release: published };
}

export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv, new Set(["commit", "windows", "kit-bootstrap", "release"]), new Set());
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { pos, opt } = args;
  const [ownerRepo, version] = pos;
  if (!ownerRepo || !/^[^/\s]+\/[^/\s]+$/.test(ownerRepo) || !version) {
    console.error(USAGE);
    return 2;
  }
  if (!R.VERSION_PATTERN.test(version)) {
    console.error(`${version} does not look like a version (2.0.0-beta.7).\n${USAGE}`);
    return 2;
  }
  if (typeof opt.commit !== "string" || !R.COMMIT_PATTERN.test(opt.commit)) {
    console.error(`--commit needs the 40-character product commit to freeze (the release's last merged commit on main).\n${USAGE}`);
    return 2;
  }
  // --windows is not asked for: without it the setup GitHub built for --commit is taken.
  if ("windows" in opt && (typeof opt.windows !== "string" || !opt.windows)) {
    console.error(`--windows needs the folder build-exe.sh wrote for that commit (${SETUP}, ${MANIFEST} and the source archive); leave it out to take the one GitHub built.\n${USAGE}`);
    return 2;
  }
  // --kit-bootstrap is not asked for: without it the commit is carried over from the beta stage.
  // Given, it has to be a commit.
  if ("kit-bootstrap" in opt && (typeof opt["kit-bootstrap"] !== "string" || !R.COMMIT_PATTERN.test(opt["kit-bootstrap"]))) {
    console.error(
      `--kit-bootstrap needs the 40-character commit of ${cfg.kitBootstrapRepo} whose setup-godspeed.sh this candidate installs with, for the release that changes it. Leave it out and the commit is carried over from the ${R.PUBLIC_STAGE} stage; the Windows bootstrap commit is never asked for, because the manifest names it.\n${USAGE}`,
    );
    return 2;
  }
  // An option this script does not know is refused rather than ignored, because parseArgs would
  // otherwise read it as true and read its value as the repository or the version. A release step
  // working from an older note than this one is told, instead of freezing a candidate under a tag
  // nothing protects: there is one tag, and the usage below names every option there is.
  const KNOWN = new Set(["commit", "windows", "kit-bootstrap", "no-staging", "release", "dry-run"]);
  const unknown = Object.keys(opt).filter((k) => !KNOWN.has(k));
  if (unknown.length) {
    console.error(`freeze does not know the option --${unknown[0]}.\n${USAGE}`);
    return 2;
  }
  try {
    await freeze({
      ownerRepo,
      version,
      commit: opt.commit,
      windows: typeof opt.windows === "string" ? opt.windows : null,
      kitBootstrap: typeof opt["kit-bootstrap"] === "string" ? opt["kit-bootstrap"] : null,
      noStaging: !!opt["no-staging"],
      releaseId: typeof opt.release === "string" ? opt.release : null,
      dryRun: !!opt["dry-run"],
      env,
      log: (s) => console.log(s),
    });
    return 0;
  } catch (e) {
    if (e instanceof R.Refused) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === THIS_FILE.toLowerCase();
if (isMain) {
  configureFromEnv();
  process.exitCode = await main(process.argv.slice(2));
}
