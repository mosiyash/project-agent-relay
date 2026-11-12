export type ErrorCode =
  | "USAGE"
  | "CONFIG"
  | "PROJECT"
  | "RUNNER"
  | "TIMEOUT"
  | "INTERRUPTED"
  | "REPORT"
  | "INTERNAL";

export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly exitCode: number,
    options?: ErrorOptions,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message, options);
    this.name = "RelayError";
  }
}

export const configError = (message: string, options?: ErrorOptions) =>
  new RelayError("CONFIG", message, 2, options);

export const projectError = (message: string, options?: ErrorOptions) =>
  new RelayError("PROJECT", message, 3, options);

export const runnerError = (message: string, options?: ErrorOptions) =>
  new RelayError("RUNNER", message, 4, options);

export const timeoutError = (
  message: string,
  details: Readonly<Record<string, string | number>> = {},
) => new RelayError("TIMEOUT", message, 4, undefined, details);

export const interruptedError = (
  message: string,
  details: Readonly<Record<string, string | number>> = {},
) => new RelayError("INTERRUPTED", message, 4, undefined, details);

export const reportError = (message: string, options?: ErrorOptions) =>
  new RelayError("REPORT", message, 5, options);
