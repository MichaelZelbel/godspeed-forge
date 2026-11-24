// The command line reader the release helpers share: positional words, and --flag or --flag value or
// --flag=value. A flag in `valueFlags` takes a value; one in `multi` may repeat and collects a list.
export function parseArgs(argv, valueFlags = new Set(), multi = new Set()) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val = eq === -1 ? undefined : a.slice(eq + 1);
      if (valueFlags.has(key)) {
        if (val === undefined) val = argv[++i];
        if (val === undefined) throw new Error(`--${key} needs a value`);
      } else val = true;
      if (multi.has(key)) (opt[key] ||= []).push(val);
      else opt[key] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}
