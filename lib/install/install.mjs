import { cp, mkdir, symlink } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { defaultPaths, installDefaults } from '../config.mjs';
import { DONE, INBOX, OUTBOX, PROJECTS } from '../inbox.mjs';
import { installAssistantPlugin } from './assistant-plugin.mjs';

// The setup skill of releases before 0.2.0. The forge skill does its job now, and two skills that both answer "set up
// the Forge" would leave the assistant unsure which to use, so the old one goes when it is the one the Forge put there.
const OLD_SETUP_SKILL = 'skills/forge-setup';
export function removeOldSetupSkill(gs, fs = nodeFs) {
  const folder = gs.workspacePath(OLD_SETUP_SKILL);
  let names;
  try { names = fs.readdirSync(folder); } catch { return false; }
  const text = gs.readWorkspaceFile(`${OLD_SETUP_SKILL}/SKILL.md`);
  const ours = names.length === 1 && names[0] === 'SKILL.md' && typeof text === 'string'
    && /^---\r?\nname: forge-setup\r?\n/.test(text) && text.includes('godspeed-forge setup owner/repository');
  if (!ours) return false;
  fs.rmSync(folder, { recursive: true, force: true });
  return true;
}

// Copies the add-on into paths.addon, links its command, writes the default settings once, and, through the bridge to
// Godspeed (gs), gives the owner's Godspeed the forge skill and the folders the chat and the Forge talk through.
export async function installAddon({ source, paths = defaultPaths(), gs, run }) {
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
  if (gs) {
    gs.installSkill('forge', join(source, 'skills', 'forge'));
    await installAssistantPlugin(gs, source, run ? { run } : {});
    removeOldSetupSkill(gs);
    for (const rel of [INBOX, DONE, OUTBOX, PROJECTS]) gs.makeWorkspaceFolder(rel);
  }
  await mkdir(dirname(paths.executable), { recursive: true });
  try {
    await symlink(join(paths.addon, 'bin/godspeed-forge.mjs'), paths.executable);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await installDefaults(paths.config);
  return paths;
}
