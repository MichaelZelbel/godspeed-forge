import { access, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';

export { constants } from 'node:fs';

// Every file operation setup makes goes through this object, so a test can make any one of them fail.
export const files = { access, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile };
