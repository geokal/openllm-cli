/** Escape arguments passed through cmd.exe shims on Windows. */
const escapeCmdArg = (arg: string): string => {
  // If the argument contains spaces and has no embedded quotes, Bun will wrap
  // it in double quotes when formatting the command line, which neutralizes
  // cmd metacharacters.
  // However, arguments with embedded quotes (e.g. colors="red & blue") or unquoted
  // arguments containing cmd metacharacters (^, &, |, <, >) must be escaped
  // so cmd.exe does not split or interpret them as shell operators.
  if (/\s/.test(arg) && !arg.includes('"')) return arg;
  return arg.replace(/[\^&|<>]/g, (match) => `^${match}`).replace(/"/g, '""');
};

/** Build a Bun.spawn command, accounting for Windows command-script shims. */
export const spawnCommand = (
  platform: NodeJS.Platform,
  target: string,
  args: readonly string[],
): string[] =>
  platform === "win32" &&
  (target.toLowerCase().endsWith(".cmd") || target.toLowerCase().endsWith(".bat"))
    ? ["cmd.exe", "/d", "/s", "/c", target, ...args.map(escapeCmdArg)]
    : [target, ...args];
