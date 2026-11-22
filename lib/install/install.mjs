import { cp, mkdir, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { defaultPaths, installDefaults } from '../config.mjs';

export async function installAddon({ source, workspace, paths = defaultPaths() }) {
  await mkdir(paths.addon, { recursive: true });
  for (const directory of ['bin', 'lib', 'skills']) {
    await cp(join(source, directory), join(paths.addon, directory), { recursive: true, force: true });
  }
  // the factory driver, without its tests
  const driverTests = join(source, 'driver', 'test');
  await cp(join(source, 'driver'), join(paths.addon, 'driver'), { recursive: true, force: true, filter: file => { const inside = relative(driverTests, file); return inside.startsWith('..') || isAbsolute(inside); } });
  for (const file of ['README.md', 'INSTALL-FOR-ASSISTANTS.md', 'LICENSE', 'VERSION']) {
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
  await installDefaults(paths.config);
  return paths;
}
