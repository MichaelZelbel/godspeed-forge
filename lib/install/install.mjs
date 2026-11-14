import { cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultPaths, defaults, installDefaults } from '../config.mjs';

import { run } from '../process.mjs';

export async function installAddon({ source, workspace, paths = defaultPaths(), scheduler = run }) {
  await mkdir(paths.addon, { recursive: true });
  for (const directory of ['bin', 'lib', 'skills']) {
    await cp(join(source, directory), join(paths.addon, directory), { recursive: true, force: true });
  }
  for (const file of ['README.md', 'INSTALL-FOR-ASSISTANTS.md', 'LICENSE']) {
    await cp(join(source, file), join(paths.addon, file), { force: true });
  }
  const skill = join(workspace, 'skills/forge-setup');
  await mkdir(skill, { recursive: true });
  await cp(join(source, 'skills/forge-setup/SKILL.md'), join(skill, 'SKILL.md'));
  await mkdir(dirname(paths.executable), { recursive: true });
  try {
    await symlink(join(paths.addon, 'bin/godspeed-forge.mjs'), paths.executable);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const configuredDefaults = { ...defaults(), godspeedRoot: workspace };
  await installDefaults(paths.config, configuredDefaults);
  await mkdir(paths.units, { recursive: true });
  const units = {};
  for (const name of ['godspeed-forge-questions.service', 'godspeed-forge-questions.timer']) {
    const template = await readFile(join(source, 'lib/install/systemd', name), 'utf8');
    const rendered = template.replaceAll('{{EXECUTABLE}}', paths.executable);
    const destination = join(paths.units, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, rendered, { mode: 0o644 });
    await rename(temporary, destination);
    units[name] = destination;
  }
  if (scheduler) {
    await scheduler('systemctl', ['--user', 'daemon-reload']);
    await scheduler('systemctl', ['--user', 'enable', '--now', 'godspeed-forge-questions.timer']);
  }
  return { ...paths, units };
}
