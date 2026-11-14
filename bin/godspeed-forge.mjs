#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access } from 'node:fs/promises';
import { defaultPaths, installDefaults, readConfig } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { setupRepository } from '../lib/setup.mjs';
import { registrationAction } from '../lib/github-apps.mjs';

async function main() {
  const [command, repository] = process.argv.slice(2);
  if (command !== 'setup' || !repository) throw new Error('Run godspeed-forge setup owner/repository.');
  const paths = defaultPaths();
  await installDefaults(paths.config);
  const config = await readConfig(paths.config);
  const input = createInterface({ input: stdin, output: stdout });
  const github = {
    async exists(path) { try { await access(path); return true; } catch { return false; } },
    async begin(manifest) {
      const owner = new URL(manifest.url).pathname.split('/')[1];
      const organization = await input.question(`Type yes if ${owner} is a GitHub organization, or no if it is your personal account: `);
      const action = registrationAction(owner, organization.trim().toLowerCase() === 'yes');
      const value = JSON.stringify(manifest).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      const page = `<form id="app" method="post" action="${action}"><input type="hidden" name="manifest" value="${value}"></form><script>document.getElementById('app').submit()</script>`;
      const url = `data:text/html;base64,${Buffer.from(page).toString('base64')}`;
      return { url };
    },
    async complete() {
      const callback = await input.question('After GitHub finishes, paste the address from your browser: ');
      let code;
      try { code = new URL(callback.trim()).searchParams.get('code'); } catch {}
      if (!code) throw new Error('The GitHub callback address did not contain a temporary code.');
      const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code.trim())}/conversions`, {
        method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'godspeed-forge' }
      });
      if (!response.ok) throw new Error('GitHub could not create the App.');
      return response.json();
    },
    async install({ credentials, repository, kind }) {
      if (!credentials.slug) throw new Error(`GitHub did not return the ${kind} App name needed for installation.`);
      const url = `https://github.com/apps/${encodeURIComponent(credentials.slug)}/installations/new`;
      console.log(`Install the ${kind} App and choose only ${repository}: ${url}`);
      const answer = await input.question(`Type yes after the ${kind} App is installed only on ${repository}: `);
      return answer.trim().toLowerCase() === 'yes';
    }
  };
  try {
    await setupRepository(repository, {
      config, paths, commands: { run }, github,
      prompt: question => input.question(`${question} `),
      output: message => console.log(message)
    });
  } finally {
    input.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
