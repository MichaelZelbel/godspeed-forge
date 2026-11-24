// The driver's release steps (stage, plan, keep-main-green) with the tests of the helpers they fold in
// (auto-stage, auto-plan, auto-drive, scope gate, feasibility, standing waiver, and the self-tests of the
// freeze, the install on the server, its check and keep-main-green). Each file in driver/test/steps marks its
// own cases; they run one after the other here so the markers never mix. test-steps-release.mjs runs last: it
// configures the helpers from other settings than the others use.
// test cases: 200
for (const f of [
  "release/test-auto-drive",
  "release/test-auto-plan",
  "release/test-auto-stage",
  "release/test-feasibility",
  "release/test-scope-gate",
  "release/test-standing-waiver",
  "release/test-freeze-selftest",
  "release/test-stage-server-selftest",
  "release/test-staging-check-selftest",
  "release/test-keep-main-green-selftest",
  "test-steps-release",
]) {
  await import(`../driver/test/steps/${f}.mjs`);
}
