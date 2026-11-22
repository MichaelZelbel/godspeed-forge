// A GitHub App installation token for role `builder` or `release` of one repository, made from the App details
// setup saved in the Forge's private credentials subtree (lib/github-apps.mjs): a JWT signed with the App's key,
// the App's installation on the repository, and a token for that installation, kept in memory until shortly
// before it expires and never written to a log or a file.
//
// The code itself lives in driver/steps/owner/app-token.mjs, because the factory driver is installed into a
// folder of its own without lib/ and its steps need the same tokens; this is the add-on's door to it, which
// turns the Forge's paths into the repository's credentials folder.
import { credentialPath } from './config.mjs';
import { mintAppToken, AppTokenError, forgetAppTokens, ROLES } from '../driver/steps/owner/app-token.mjs';

export { AppTokenError, forgetAppTokens, ROLES };

// paths: the Forge's paths (defaultPaths()), of which only paths.state is read. api: GitHub's API address
// (default https://api.github.com, or FORGE_GITHUB_API_URL). fetch and now: stand-ins for a test.
export function appToken({ repository, role, paths, api, fetch, now }) {
  return mintAppToken({ credentialDirectory: credentialPath(paths.state, repository), repository, role, api, fetch, now });
}
