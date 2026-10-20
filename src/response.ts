const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function text(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

export function apiError(
  status: number,
  error: string,
  message: string,
  txtOnly = false,
  headers: HeadersInit = {},
): Response {
  return txtOnly ? text("", status, headers) : json({ error, message }, status, headers);
}

export function isoTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}
