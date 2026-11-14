/** Escape arguments passed through cmd.exe shims on Windows. */
const escapeCmdArg = (arg: string): string => {
  // If the argument contains spaces, Bun will wrap it in double quotes when
  // formatting the command line, which neutralizes cmd metacharacters.
  // Unquoted arguments containing cmd metacharacters (^, &, |, <, >) must be
  // caret-escaped so cmd.exe does not split or interpret them as shell operators.
  if (/\s/.test(arg)) return arg;
  return arg.replace(/[\^&|<>]/g, (match) => `^${match}`);
};

/** Build a Bun.spawn command, accounting for Windows command-script shims. */
export const spawnCommand = (
  platform: NodeJS.Platform,
  target: string,
  args: readonly string[],
): string[] =>
  platform === "win32" &&
  (target.toLowerCase().endsWith(".cmd") || target.toLowerCase().endsWith(".bat"))
    ? ["cmd.exe", "/d", "/s", "/c", "call", target, ...args.map(escapeCmdArg)]
    : [target, ...args];
