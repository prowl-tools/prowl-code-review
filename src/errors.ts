export function errorCause(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message);
  error.cause = errorCause(cause);
  return error;
}
