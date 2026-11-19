import { AFRESH_PARTS } from '../lib/setup.mjs';

// What the owner asks for when a stop says to start a saved file afresh, as the forge-setup skill maps it: the
// part passed to setup as --start-afresh (startAfresh), or undefined when the stop asks no such thing.
export function afreshPart(stop) {
  return Object.keys(AFRESH_PARTS).find(part => stop.includes(`start ${AFRESH_PARTS[part].words} afresh`));
}
