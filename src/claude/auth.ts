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
  /**
   * What Claude Code signs in with (authMethod): "claude.ai" for the login saved
   * in the config dir, or a credential that comes before it (F29), such as
   * "api_key"; null when it doesn't say.
   */
  method: string | null;
  /** Set when the status couldn't be read at all. */
  error: string | null;
}

/**
 * `claude auth status`: JSON by default, exit 0 when logged in and 1
 * when not. The JSON has authMethod, plus email, orgId and orgName for
 * claude.ai logins.
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
      method: str(json.authMethod),
      error: null,
    };
  } catch {
    const why = (res.stderr || res.stdout).trim().split("\n")[0] || `exit code ${res.code}`;
    return { loggedIn: false, email: null, orgId: null, orgName: null, method: null, error: why };
  }
}

/** The credentials Claude Code can sign in with instead of a claude.ai login, by authMethod. */
const NOT_A_LOGIN: Record<string, string> = {
  oauth_token: "a token",
  api_key: "an API key",
  api_key_helper: "apiKeyHelper",
  third_party: "a cloud provider",
};

/** What a logged-in status signs in with when that isn't a claude.ai login ("an API key"), or null. */
export function otherCredential(s: AuthStatus): string | null {
  if (s.error || !s.loggedIn || s.method === null) return null;
  return NOT_A_LOGIN[s.method] ?? null;
}

/** "alice@x.com (Acme)", "an API key", "not logged in", or the reason it couldn't be read. */
export function describeLogin(s: AuthStatus): string {
  if (s.error) return `unknown (${s.error})`;
  if (!s.loggedIn) return "not logged in";
  const other = otherCredential(s);
  if (other) return s.email ? `${other} (${s.email})` : other;
  const who = s.email ?? "logged in";
  return s.orgName ? `${who} (${s.orgName})` : who;
}
