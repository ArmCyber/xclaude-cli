// Running claude subcommands for an identity: auth status/logout, daemon stop.
import { execFile } from "node:child_process";
import { shellWay } from "./runnable.ts";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs claude with captured output; never throws. */
export function runClaude(claude: string, args: string[], env: Record<string, string>, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const [file, fileArgs] = shellWay(claude, args);
    execFile(file, fileArgs, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? (error ? error.message : "") });
    });
  });
}

export interface AuthStatus {
  loggedIn: boolean;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  /** Set when the status couldn't be read at all. */
  error: string | null;
}

/**
 * `claude auth status`: JSON by default, exit 0 when logged in and 1
 * when not. The JSON has email, orgId and orgName for claude.ai logins.
 */
export async function authStatus(claude: string, env: Record<string, string>): Promise<AuthStatus> {
  const res = await runClaude(claude, ["auth", "status"], env);
  try {
    const json = JSON.parse(res.stdout) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      loggedIn: json.loggedIn === true,
      email: str(json.email),
      orgId: str(json.orgId),
      orgName: str(json.orgName),
      error: null,
    };
  } catch {
    const why = (res.stderr || res.stdout).trim().split("\n")[0] || `exit code ${res.code}`;
    return { loggedIn: false, email: null, orgId: null, orgName: null, error: why };
  }
}

/** "alice@x.com (Acme)", "not logged in", or the reason it couldn't be read. */
export function describeLogin(s: AuthStatus): string {
  if (s.error) return `unknown (${s.error})`;
  if (!s.loggedIn) return "not logged in";
  const who = s.email ?? "logged in";
  return s.orgName ? `${who} (${s.orgName})` : who;
}
