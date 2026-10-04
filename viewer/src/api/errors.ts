/** An error response from the scratchcad service or the MCP file API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** For a 409 from the file API: the file's version on disk, or null if deleted. */
  readonly current: string | null | undefined;

  constructor(status: number, code: string, message: string, current?: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

/** Both backends answer errors as {"error": {"code", "message", ...}}. */
export async function errorFrom(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error: { code: string; message: string; current?: string | null };
    };
    return new ApiError(response.status, body.error.code, body.error.message, body.error.current);
  } catch {
    const text = `${response.status} ${response.statusText}`.trim();
    return new ApiError(response.status, "http_error", text);
  }
}
