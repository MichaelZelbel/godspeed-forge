// The driver's tests are written for node:test. Under test/run.sh (test/driver.test.mjs) every case is collected here and
// run one after the other, each marked for run.sh's "case passed:" count; on its own, `node --test <file>` still works.
import nodeTest from "node:test";

export function test(name, options, fn) {
  const body = typeof options === "function" ? options : fn;
  if (globalThis.__forgeCases) { globalThis.__forgeCases.push({ name, body }); return undefined; }
  return typeof options === "function" ? nodeTest(name, options) : nodeTest(name, options, fn);
}
export default test;
