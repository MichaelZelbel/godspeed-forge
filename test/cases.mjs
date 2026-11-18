// Marks where each test case of a node test file begins, so test/run.sh can count cases, not files.
// A case runs from its testCase(name) call to the next one, or to the end of the file. Each case prints
// "case passed: <name>" once it ends, or "case failed: <name>" when the file stops inside it.
import { writeSync } from 'node:fs';

let current = null;
const say = line => writeSync(1, `${line}\n`);

export function testCase(name) {
  if (current !== null) say(`case passed: ${current}`);
  current = name;
}

process.on('exit', code => {
  if (current !== null) say(`case ${code === 0 ? 'passed' : 'failed'}: ${current}`);
});
