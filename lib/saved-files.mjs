import { files } from './files.mjs';

const MISSING = Object.freeze({ state: 'missing' });
const unreadable = kind => ({ state: 'unreadable', kind });
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// What setup finds at a path where it saves a file: { state: 'missing' }; { state: 'readable', value }, the
// parsed object (or the text, when json is false); or { state: 'unreadable', kind }, where kind is 'empty',
// 'damaged' (not JSON, not an object, or not valid), 'dangling' (a link to nothing), 'folder' or 'denied'
// (any other refusal by the file system). Every file setup saves is read through here, and a file read as
// unreadable is never written over, emptied, moved or deleted, except by startFileAfresh.
export async function readSavedFile(path, { json = true, valid = () => true } = {}) {
  let entry;
  try {
    entry = await files.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return MISSING;
    if (typeof error?.code === 'string') return unreadable('denied');
    throw error;
  }
  let text;
  try {
    text = await files.readFile(path, 'utf8');
  } catch (error) {
    if (entry.isSymbolicLink() && (error?.code === 'ENOENT' || error?.code === 'ELOOP')) return unreadable('dangling');
    if (error?.code === 'ENOENT') return MISSING;
    if (error?.code === 'EISDIR') return unreadable('folder');
    if (typeof error?.code === 'string') return unreadable('denied');
    throw error;
  }
  if (text === '') return unreadable('empty');
  if (!json) return { state: 'readable', value: text };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable('damaged');
  }
  return isPlainObject(value) && valid(value) ? { state: 'readable', value } : unreadable('damaged');
}

// Removes a saved file setup could not read, once the owner has asked setup to start that file afresh.
export async function startFileAfresh(path) {
  await files.rm(path, { recursive: true, force: true });
}
