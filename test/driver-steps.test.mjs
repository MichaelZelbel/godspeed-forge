// The driver's folded helpers (trust, questions and its accountant, test-machine) with their moved tests. Each file in
// driver/test/steps marks its own cases; they run one after the other here so the markers never mix.
// test cases: 126
for (const f of ["test-trust", "test-steps-engine", "test-factory-owner-questions", "test-question-rules", "test-question-pager", "test-question-check", "test-question-driver", "test-question-replay", "test-question-review", "test-question-withdrawn", "test-test-machine", "test-referee"]) {
  await import(`../driver/test/steps/${f}.mjs`);
}
