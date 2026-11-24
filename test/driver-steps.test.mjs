// The driver's folded helpers (trust, questions, test-machine) with their moved tests. Each file in
// driver/test/steps marks its own cases; they run one after the other here so the markers never mix.
// test cases: 86
for (const f of ["test-trust", "test-steps-engine", "test-factory-owner-questions", "test-test-machine", "test-referee"]) {
  await import(`../driver/test/steps/${f}.mjs`);
}
