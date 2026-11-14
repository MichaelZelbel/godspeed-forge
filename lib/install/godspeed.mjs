export function supportedVersion(installed, minimum) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(value.replace(/^v/, ''));
    if (!match) throw new Error(`Could not understand Godspeed version ${value}.`);
    return match.slice(1).map(value => value === undefined ? Number.MAX_SAFE_INTEGER : Number(value));
  };
  const left = parse(installed);
  const right = parse(minimum);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export async function godspeedVersion(runCommand, command = 'godspeed') {
  return (await runCommand(command, ['--version'])).stdout.trim().replace(/^godspeed\s+/i, '');
}
