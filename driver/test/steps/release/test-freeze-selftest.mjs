// The self-test of freeze.mjs, moved out of the shipped file unchanged. It runs the real helper as its own
// process against stand-ins for GitHub and the server (stand-ins.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../../steps/release/args.mjs";
import * as R from "../../../steps/release/release-api.mjs";
import * as G from "../../../steps/release/staging.mjs";
import { checkScope } from "../../../steps/release/scope-gate.mjs";
import { stageServer } from "../../../steps/release/stage-server.mjs";
import { fileURLToPath as __f2u } from "node:url";
import * as M from "../../../steps/release/freeze.mjs";
import { configure } from "../../../steps/release/config.mjs";
import { TEST_RELEASE_SETTINGS } from "./settings-fixture.mjs";
configure(TEST_RELEASE_SETTINGS);
const { windowsArtifact, freeze, main, SETUP, MANIFEST, SUMS, SOURCES, USAGE, stageAfterFreeze, windowsFromGitHub, windowsFolder } = M;
const THIS_FILE = __f2u(new URL("../../../steps/release/freeze.mjs", import.meta.url));

// ---------- self-test ----------

function runSelf(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [THIS_FILE, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function selfTest() {
  const S = await import("./stand-ins.mjs");
  const t = R.reporter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-self-test-"));
  const tokens = S.writeTokenScript(tmp);
  const VERSION = "2.0.0-beta.7";
  const TAG = `candidate/${VERSION}`;
  let folders = 0;

  // One freeze against its own stand-in GitHub, registry and token script. The command line is the
  // one the ticket names, with no --kit-bootstrap, unless kitBootstrap names a commit to override
  // the one the beta stage holds.
  // With server set, the repository is the product, and the freeze goes on to put it on a stand-in
  // server, recording into a stand-in godspeed-dev.
  let staged = 0;
  // fromGitHub: no --windows; the setup is the artifact GitHub built ({} for one on main's commit,
  // {expired: true}, {none: true} for none at all).
  const gh = S.writeGhStandIn(path.join(tmp, "gh"), path.join(tmp, "artifacts"));
  const run = async ({ schema, manifestVersion, manifestCommit, before, kitBootstrap, args = [], server = null, fromGitHub = null } = {}) => {
    const w = S.makeWorld();
    const seed = S.seedProduct(w, { ...(schema ? { schema } : {}), ...(server ? { ownerRepo: G.PRODUCT_REPO } : {}) });
    const stand = await S.startStandIns(w);
    let serverEnv = {};
    let ssh = null;
    let records = null;
    if (server) {
      const dir = path.join(tmp, `server-${++staged}`);
      ssh = S.writeSshStandIn(dir, S.serverState({ version: "2.0.0-beta.6", ...server, installTo: { version: VERSION, commit: seed.mainCommit, ...(server.installTo || {}) } }));
      records = S.makeRecordsRepo(path.join(dir, "records"), { "godspeed-2.0.0-beta.7-test": G.PRODUCT_REPO });
      serverEnv = { ...ssh.env, RELEASE_RECORDS_ROOT: records.root, STAGING_POLL_MS: "5", STAGING_INSTALL_MAX_MS: "3000", STAGING_SCENARIOS_POLL_MS: "5", STAGING_SCENARIOS_MAX_MS: "400" };
    }
    try {
      const env = { ...S.standInEnv({ urls: stand.urls, tokenScript: tokens.script }), ...serverEnv, RELEASE_GH_SCRIPT: gh.script };
      const built = { version: manifestVersion || VERSION, productCommit: manifestCommit || seed.mainCommit, bootstrapCommit: seed.windowsBootstrapCommit };
      let win;
      if (!fromGitHub) win = S.writeWindowsFolder(path.join(tmp, `windows-${++folders}`), built);
      else if (!fromGitHub.none) win = S.addWindowsArtifact(w, seed, { root: path.join(tmp, "artifacts"), commit: built.productCommit, version: built.version, bootstrapCommit: built.bootstrapCommit, expired: !!fromGitHub.expired });
      if (before) before({ w, seed, win });
      const ghBefore = gh.calls().length;
      const r = await runSelf(
        [seed.ownerRepo, VERSION, "--commit", seed.mainCommit, ...(fromGitHub ? [] : ["--windows", win.folder]), ...(kitBootstrap ? ["--kit-bootstrap", kitBootstrap] : []), ...args],
        env,
      );
      return { w, seed, win, r, writes: S.writes(w), ssh, gh: gh.calls().slice(ghBefore), staging: records ? records.json("releases/godspeed-2.0.0-beta.7-test/staging.json") : null };
    } finally {
      await stand.close();
    }
  };

  try {
    // ---- the freeze that works
    const good = await run();
    const stageCommit = good.seed.repo.refs[`tags/${TAG}`];
    const files = stageCommit ? S.filesAt(good.seed.repo, stageCommit) : {};
    const text = files[R.STAGE_FILE] ? files[R.STAGE_FILE].toString("utf8") : "";
    const stage = text ? JSON.parse(text) : {};
    const wrote =
      good.r.code === 0 &&
      stage.stageFormat === 1 &&
      stage.version === VERSION &&
      stage.productCommit === good.seed.mainCommit &&
      same(stage.kitBootstrap, { unixEngineCommit: good.seed.olderEngine, windowsBootstrapCommit: good.seed.windowsBootstrapCommit }) &&
      same(stage.serverEditions, { server: { image: `${good.seed.image}@${good.seed.digest}` } }) &&
      same(stage.windowsSetup, { file: "GodspeedSetup.exe", releaseTag: TAG, sha256: good.win.setupSha256 }) &&
      same(stage.addons, S.addonPinsOf(good.seed)) &&
      same(stage.previous, { version: good.seed.betaStage.version, stageCommit: good.seed.betaCommit }) &&
      same(stage.withdrawn, good.seed.betaStage.withdrawn);
    t.ok(wrote, `writes the stage with previous and withdrawn carried from beta (exit ${good.r.code} ${good.r.stderr.trim()})`);
    t.ok(text === `${JSON.stringify(stage, null, 2)}\n`, "writes the stage file the one layout the product's readers accept");

    const commitObject = good.seed.repo.commits[stageCommit];
    const diff = (before, after) => {
      const names = new Set([...Object.keys(before), ...Object.keys(after)]);
      return [...names].filter((n) => String(before[n]) !== String(after[n])).sort();
    };
    const changed = stageCommit ? diff(S.filesAt(good.seed.repo, good.seed.mainCommit), files) : [];
    t.ok(same(changed, [R.STAGE_FILE]) && commitObject && same(commitObject.parents, [good.seed.mainCommit]), `one commit changing only stage.json, on top of the commit it freezes (it changed ${changed.join(", ") || "nothing"})`);
    t.ok(!!stageCommit && good.seed.repo.refs["heads/main"] === good.seed.mainCommit, `tags the commit ${TAG}, and main is left where it was`);

    const release = good.seed.repo.releases.find((r) => r.tag_name === TAG);
    const names = release ? release.assets.map((a) => a.name).sort() : [];
    const sums = release && release.assets.find((a) => a.name === "SHA256SUMS");
    const sumsAgree =
      !!sums &&
      sums.bytes
        .toString("utf8")
        .trim()
        .split("\n")
        .every((line) => {
          const [checksum, name] = line.split(/\s+/);
          const asset = release.assets.find((a) => a.name === name);
          return asset && R.sha256Of(asset.bytes) === checksum;
        });
    t.ok(
      !!release && !release.draft && release.prerelease && !release.latest && same(names, ["Godspeed-v2-integrated-source.tar.gz", "GodspeedSetup.exe", "SHA256SUMS", "windows-manifest.json"]) && sumsAgree,
      `publishes a pre-release that is not Latest, with the setup, the manifest, the source archive and SHA256SUMS that agree (${names.join(", ")})`,
    );
    t.ok(
      S.onlyReleaseTokens(good.w, tokens) && tokens.calls().every((c) => /^release \S+ --permissions contents=(write|read)$/.test(c)),
      `every step uses a release token, never another (the token script was asked: ${tokens.calls().join("; ")})`,
    );

    // ---- the four refusals before anything is written
    const noImage = await run({ before: ({ w }) => (w.registry = {}) });
    t.ok(noImage.r.code === 1 && /not in the registry/.test(noImage.r.stderr), `refuses when the server image does not exist (exit ${noImage.r.code}: ${noImage.r.stderr.trim().split("\n")[0]})`);

    const otherCommit = await run({ manifestCommit: "0".repeat(40) });
    t.ok(otherCommit.r.code === 1 && /as the product commit, not/.test(otherCommit.r.stderr), `refuses when the manifest names another commit (exit ${otherCommit.r.code}: ${otherCommit.r.stderr.trim().split("\n")[0]})`);

    const otherVersion = await run({ manifestVersion: "2.0.0-beta.9" });
    t.ok(otherVersion.r.code === 1 && /says version 2\.0\.0-beta\.9, not/.test(otherVersion.r.stderr), `refuses when the manifest names another version (exit ${otherVersion.r.code}: ${otherVersion.r.stderr.trim().split("\n")[0]})`);

    const tagThere = await run({ before: ({ seed }) => (seed.repo.refs[`tags/${TAG}`] = seed.betaCommit) });
    t.ok(tagThere.r.code === 1 && /already has the tag/.test(tagThere.r.stderr), `refuses when the tag already exists (exit ${tagThere.r.code}: ${tagThere.r.stderr.trim().split("\n")[0]})`);

    const wroteNothing = [noImage, otherCommit, otherVersion, tagThere];
    t.ok(
      wroteNothing.every((c) => c.writes.length === 0 && !c.seed.repo.releases.some((r) => r.tag_name === TAG)),
      `writes nothing when it refuses (the four refusals above sent ${wroteNothing.map((c) => c.writes.length).join(", ")} writes to GitHub)`,
    );

    // ---- a checksum that does not match what was attached
    const corrupt = await run({ before: ({ w }) => (w.corruptUpload = "GodspeedSetup.exe") });
    const draft = corrupt.seed.repo.releases.find((r) => r.tag_name === TAG);
    t.ok(
      corrupt.r.code === 1 && /read back from the draft release/.test(corrupt.r.stderr) && !!draft && draft.draft && !draft.latest,
      `refuses when a checksum read back from the draft does not match, and leaves the release unpublished (exit ${corrupt.r.code}: ${corrupt.r.stderr.trim().split("\n")[0]})`,
    );

    // ---- one tag: the stage commit carries candidate/<version>, the release is published on that
    //      same tag, the stage names it, and no candidate-<version> tag or release exists anywhere
    const strayTag = `candidate-${VERSION}`;
    t.ok(
      stage.windowsSetup.releaseTag === TAG &&
        good.seed.repo.refs[`tags/${TAG}`] === stageCommit &&
        good.seed.repo.releases.some((r) => r.tag_name === TAG) &&
        !good.seed.repo.refs[`tags/${strayTag}`] &&
        !good.seed.repo.releases.some((r) => r.tag_name === strayTag),
      `the release is published on ${TAG}, the tag the stage commit carries and the stage names, and there is no ${strayTag} tag or release`,
    );

    // ---- the Unix kit-bootstrap commit: carried over from beta when no flag names it (the command
    //      line of the ticket's point 1, which every run above used), overridden when one does
    t.ok(
      stage.kitBootstrap.unixEngineCommit === good.seed.olderEngine && good.seed.olderEngine === good.seed.betaStage.kitBootstrap.unixEngineCommit,
      `carries the Unix kit-bootstrap commit over from beta when no --kit-bootstrap names one (${String(good.seed.olderEngine).slice(0, 7)})`,
    );
    const overridden = await run({ kitBootstrap: good.seed.unixEngineCommit });
    const overriddenStage = (() => {
      const at = overridden.seed.repo.refs[`tags/${TAG}`];
      const held = at ? S.filesAt(overridden.seed.repo, at) : {};
      return held[R.STAGE_FILE] ? JSON.parse(held[R.STAGE_FILE].toString("utf8")) : {};
    })();
    t.ok(
      overridden.r.code === 0 &&
        overriddenStage.kitBootstrap &&
        overriddenStage.kitBootstrap.unixEngineCommit === overridden.seed.unixEngineCommit &&
        overriddenStage.kitBootstrap.unixEngineCommit !== overridden.seed.olderEngine &&
        overriddenStage.kitBootstrap.windowsBootstrapCommit === overridden.seed.windowsBootstrapCommit,
      `--kit-bootstrap overrides the carried commit for the release that changes it (${String(overridden.seed.unixEngineCommit).slice(0, 7)}, exit ${overridden.r.code} ${overridden.r.stderr.trim()})`,
    );
    const noEngine = await run({
      before: ({ w, seed }) => {
        const stripped = { ...seed.betaStage, kitBootstrap: { windowsBootstrapCommit: seed.betaStage.kitBootstrap.windowsBootstrapCommit } };
        const files = { ...S.filesAt(seed.repo, seed.betaCommit), [R.STAGE_FILE]: `${JSON.stringify(stripped, null, 2)}\n` };
        seed.repo.refs[`heads/${R.PUBLIC_STAGE}`] = S.addCommit(w, seed.ownerRepo, { message: "a beta stage naming no Unix engine commit", files });
      },
    });
    t.ok(
      noEngine.r.code === 1 && /unixEngineCommit/.test(noEngine.r.stderr) && /--kit-bootstrap/.test(noEngine.r.stderr) && noEngine.writes.length === 0,
      `refuses, writing nothing, when beta's stage names no Unix engine commit and no --kit-bootstrap does either (exit ${noEngine.r.code}: ${noEngine.r.stderr.trim().split("\n")[0]})`,
    );

    // ---- a commit older than ticket 1b: its schema refuses the one tag, so freeze refuses too,
    //      rather than publishing under a second tag nothing protects
    const oldSchema = await run({ schema: S.SCHEMA_REFUSING_SLASH_TAG });
    t.ok(
      oldSchema.r.code === 1 &&
        /windowsSetup\.releaseTag/.test(oldSchema.r.stderr) &&
        /ticket 1b/.test(oldSchema.r.stderr) &&
        oldSchema.writes.length === 0 &&
        !oldSchema.seed.repo.refs[`tags/${strayTag}`] &&
        !oldSchema.seed.repo.releases.some((r) => r.tag_name === strayTag),
      `refuses, writing nothing, when the schema at that commit does not allow the release tag ${TAG}, and falls back to no second tag (exit ${oldSchema.r.code}: ${oldSchema.r.stderr.trim().split("\n")[0]})`,
    );

    // ---- freeze takes the options its usage names and no others, so the option that once chose
    //      the release's tag by hand is refused now rather than quietly ignored (--website is one
    //      promote takes and freeze does not, the kind of mix-up this catches)
    const strayFlag = await run({ args: ["--website", "echo hello"] });
    t.ok(
      strayFlag.r.code === 2 && /does not know the option --website/.test(strayFlag.r.stderr) && strayFlag.writes.length === 0,
      `refuses an option it does not know instead of ignoring it (exit ${strayFlag.r.code}: ${strayFlag.r.stderr.trim().split("\n")[0]})`,
    );

    // ---- the candidate goes on the maintainer's server right after a freeze of the product, and
    //      never after a freeze of anything else (every run above froze Owner/Product)
    t.ok(/is not MichaelZelbel\/godspeed-mission-control, so nothing is put on your server/.test(good.r.stdout), "a freeze of another repository, a rehearsal copy, puts nothing on the server");
    const product = await run({ server: {} });
    t.ok(
      product.r.code === 0 &&
        product.ssh.calls().some((c) => c.op === "install") &&
        !!product.staging &&
        product.staging.status === "installed" &&
        product.staging.version === VERSION &&
        product.staging.productCommit === product.seed.mainCommit,
      `a freeze of the product puts the candidate on the server and records it as installed (exit ${product.r.code} ${product.r.stderr.trim()})`,
    );
    const skipped = await run({ server: {}, args: ["--no-staging"] });
    t.ok(
      skipped.r.code === 0 && !skipped.ssh.calls().length && !skipped.staging && !!skipped.seed.repo.refs[`tags/${TAG}`] && /--no-staging/.test(skipped.r.stdout),
      "--no-staging freezes the product and puts nothing on the server",
    );
    const sickServer = await run({ server: { health: { ok: false } } });
    t.ok(
      sickServer.r.code === 1 && /is frozen, but it was not put on your server/.test(sickServer.r.stderr) && !!sickServer.seed.repo.refs[`tags/${TAG}`] && !sickServer.ssh.calls().some((c) => c.op === "install"),
      `says loudly when the candidate is frozen but could not be put on the server (exit ${sickServer.r.code}: ${sickServer.r.stderr.trim().split("\n")[0]})`,
    );
    const dryProduct = await run({ server: {}, args: ["--dry-run"] });
    t.ok(dryProduct.r.code === 0 && !dryProduct.ssh.calls().length && /put it on your server: node \S*stage-server\.mjs/.test(dryProduct.r.stdout) && !/Start the scenarios now/.test(dryProduct.r.stdout), "--dry-run of the product says it would put the candidate on the server, and asks the server nothing");

    // ---- without --windows, the setup is the one GitHub built for --commit: the artifact
    //      windows-setup-<sha>, found and downloaded with a release token narrowed to actions=read
    const fromGitHub = await run({ fromGitHub: {} });
    const ghStage = (() => {
      const at = fromGitHub.seed.repo.refs[`tags/${TAG}`];
      const held = at ? S.filesAt(fromGitHub.seed.repo, at) : {};
      return held[R.STAGE_FILE] ? JSON.parse(held[R.STAGE_FILE].toString("utf8")) : {};
    })();
    const ghRelease = fromGitHub.seed.repo.releases.find((r) => r.tag_name === TAG);
    const ghSetup = ghRelease && ghRelease.assets.find((a) => a.name === "GodspeedSetup.exe");
    const download = fromGitHub.gh[0] || { args: [] };
    t.ok(
      fromGitHub.r.code === 0 &&
        ghStage.windowsSetup &&
        ghStage.windowsSetup.sha256 === fromGitHub.win.setupSha256 &&
        !!ghSetup &&
        ghSetup.bytes.equals(fromGitHub.win.setupBytes) &&
        fromGitHub.gh.length === 1 &&
        download.args.join(" ").startsWith(`run download ${fromGitHub.win.run} --repo ${fromGitHub.seed.ownerRepo} --name windows-setup-${fromGitHub.seed.mainCommit} --dir `) &&
        /^ghs_fake_release_\d+_actions_read$/.test(download.token) &&
        /artifact windows-setup-\S+ of run \d+/.test(fromGitHub.r.stdout),
      `without --windows it freezes the setup GitHub built for the commit, downloaded with gh and a release token narrowed to actions=read (exit ${fromGitHub.r.code} ${fromGitHub.r.stderr.trim()})`,
    );
    t.ok(S.onlyReleaseTokens(fromGitHub.w, tokens), "listing and downloading the artifact use release tokens only, never the maintainer's own");
    const noArtifact = await run({ fromGitHub: { none: true } });
    t.ok(
      noArtifact.r.code === 1 && /GitHub holds no Windows setup built for commit \w+ \(no artifact windows-setup-/.test(noArtifact.r.stderr) && noArtifact.writes.length === 0 && !noArtifact.gh.length,
      `refuses, writing nothing, when GitHub built no setup for the commit (exit ${noArtifact.r.code}: ${noArtifact.r.stderr.trim().split("\n")[0]})`,
    );
    const expired = await run({ fromGitHub: { expired: true } });
    t.ok(expired.r.code === 1 && /has expired/.test(expired.r.stderr) && expired.writes.length === 0, `refuses when the artifact has expired (exit ${expired.r.code})`);
    const builtOther = await run({ fromGitHub: {}, manifestVersion: "2.0.0-beta.9" });
    t.ok(builtOther.r.code === 1 && /says version 2\.0\.0-beta\.9, not/.test(builtOther.r.stderr) && builtOther.writes.length === 0, "the artifact's manifest is checked like a folder's: another version is refused");
    const dryGitHub = await run({ fromGitHub: {}, args: ["--dry-run"] });
    t.ok(
      dryGitHub.r.code === 0 && dryGitHub.writes.length === 0 && dryGitHub.gh.length === 1 && /artifact windows-setup-/.test(dryGitHub.r.stdout) && dryGitHub.r.stdout.includes(dryGitHub.win.setupSha256),
      `--dry-run without --windows finds and checks the artifact, and writes nothing (exit ${dryGitHub.r.code})`,
    );

    // ---- the dry run
    const dry = await run({ args: ["--dry-run"] });
    t.ok(
      dry.r.code === 0 && dry.writes.length === 0 && !dry.seed.repo.refs[`tags/${TAG}`] && dry.seed.repo.releases.length === 1 && /"version": "2\.0\.0-beta\.7"/.test(dry.r.stdout) && tokens.calls().pop() === `release ${dry.seed.ownerRepo} --permissions contents=read`,
      `--dry-run changes nothing, prints the stage file it would write, and its token is read-only (exit ${dry.r.code}, ${dry.writes.length} writes)`,
    );

    // ---- a rebuilt candidate comes from the release branch, not main: main moved on (here: it no longer
    //      holds the commit at all) and the commit is on release/<version> (auto-drive.mjs cut it there)
    const BRANCH = R.releaseBranch(VERSION);
    const offMain = await run({
      before: ({ seed }) => {
        seed.repo.refs[`heads/${BRANCH}`] = seed.mainCommit;
        seed.repo.refs["heads/main"] = seed.betaCommit;
      },
    });
    const offTag = offMain.seed.repo.refs[`tags/${TAG}`];
    const offRelease = offMain.seed.repo.releases.find((r) => r.tag_name === TAG);
    t.ok(
      offMain.r.code === 0 &&
        !!offTag &&
        same(offMain.seed.repo.commits[offTag].parents, [offMain.seed.mainCommit]) &&
        offMain.seed.repo.refs["heads/main"] === offMain.seed.betaCommit &&
        offMain.seed.repo.refs[`heads/${BRANCH}`] === offMain.seed.mainCommit &&
        new RegExp(`is on ${BRANCH.replace(/\./g, "\\.")}\\.`).test(offMain.r.stdout) &&
        !!offRelease && offRelease.body.includes(`on ${BRANCH}.`),
      `freezes a commit that is on ${BRANCH} and not on main, and touches neither branch (exit ${offMain.r.code} ${offMain.r.stderr.trim()})`,
    );
    const nowhere = await run({ before: ({ seed }) => (seed.repo.refs["heads/main"] = seed.betaCommit) });
    t.ok(
      nowhere.r.code === 1 && /is neither on main of \S+ nor on its release branch release\/2\.0\.0-beta\.7/.test(nowhere.r.stderr) && nowhere.writes.length === 0,
      `refuses, writing nothing, a commit on neither main nor the release branch (exit ${nowhere.r.code}: ${nowhere.r.stderr.trim().split("\n")[0]})`,
    );
    t.ok(
      R.releaseBranch("2.0.0-beta.26") === "release/2.0.0-beta.26" && R.releaseBranch("2.0.0-beta.26.1") === "release/2.0.0-beta.26" && R.releaseBranch("2.0.0-beta.26.2") === "release/2.0.0-beta.26",
      "a release and its re-freezes share one release branch",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(t.failures ? `${t.failures} self-test check(s) failed.` : "All freeze self-tests passed.");
  return t.failures ? 1 : 0;
}

test("freeze self-test", async () => {
  assert.equal(await selfTest(), 0);
});
