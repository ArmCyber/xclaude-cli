// The Node version and platform xclaude runs on.
export const MIN_NODE: readonly [number, number] = [22, 15];

/** Why xclaude can't run here, or null when it can. */
export function runtimeProblem(platform: string, nodeVersion: string): string | null {
  if (platform !== "darwin" && platform !== "linux") {
    return `${platform} isn't supported; xclaude runs on macOS and Linux (including WSL)`;
  }
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    return `Node ${MIN_NODE.join(".")} or later is required (this is ${nodeVersion})`;
  }
  return null;
}
