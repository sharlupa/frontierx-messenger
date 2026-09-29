// A small typed error carrying an HTTP status. Route handlers throw these and
// the top-level listener maps them to JSON responses.
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "HttpError"
  }
}
