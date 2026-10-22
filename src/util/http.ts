/** The HTTP status carried by an Octokit RequestError (or anything shaped like one). */
export function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  return undefined;
}
