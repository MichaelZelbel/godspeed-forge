// What the owner asks for when a stop says to start a saved file afresh, as the forge-setup skill maps it: the
// part passed to setup as --start-afresh (startAfresh), or undefined when the stop asks no such thing.
const PHRASES = [
  [/start the Forge's settings afresh/, () => 'settings'],
  [/start the project's mission file afresh/, () => 'mission'],
  [/start setup's list of GitHub Apps afresh/, () => 'app-list'],
  [/start the (builder|release) App's saved details afresh/, kind => `${kind}-app`],
  [/start the saved details of both Apps afresh/, () => 'both-apps'],
  [/start connecting the (builder|release) App afresh/, kind => `${kind}-connection`]
];

export function afreshPart(stop) {
  for (const [phrase, part] of PHRASES) {
    const match = stop.match(phrase);
    if (match) return part(match[1]);
  }
  return undefined;
}
