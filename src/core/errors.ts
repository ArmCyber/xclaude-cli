// Exit codes: 0 success, 1 runtime error, 2 usage error, 130 picker cancelled.
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CANCELLED = 130;

/** An error meant for the user: printed as "xclaude: <message>", without a stack. */
export class XError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Wrong arguments: exit code 2. */
export class UsageError extends XError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
  }
}

/** The user cancelled a picker or a confirmation: exit code 130, nothing printed. */
export class Cancelled extends XError {
  constructor() {
    super("", EXIT_CANCELLED);
  }
}
