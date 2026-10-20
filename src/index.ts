import { authenticate } from "./auth";
import { handleRecords } from "./handlers/records";
import { handleRegister } from "./handlers/register";
import { handleResolve } from "./handlers/resolve";
import { apiError } from "./response";
import type { Env } from "./types";

const ROUTES: Record<string, string> = {
  "/register": "POST",
  "/resolve": "GET",
  "/records": "GET",
};

function isTxtQuery(url: URL): boolean {
  return (url.pathname === "/resolve" || url.pathname === "/records") && url.searchParams.get("output") !== "json";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const txtError = isTxtQuery(url);
    try {
      const user = await authenticate(request, env.DB);
      if (!user) {
        return apiError(401, "unauthorized", "Authentication required", txtError, {
          "WWW-Authenticate": 'Basic realm="Host IP Registry", charset="UTF-8"',
        });
      }

      const expectedMethod = ROUTES[url.pathname];
      if (expectedMethod && request.method !== expectedMethod) {
        return apiError(405, "method_not_allowed", "Request method is not allowed", txtError, {
          Allow: expectedMethod,
        });
      }
      if (url.pathname === "/register") return handleRegister(request, env, user);
      if (url.pathname === "/resolve") return handleResolve(request, env);
      if (url.pathname === "/records") return handleRecords(request, env);

      if (request.method !== "GET" && request.method !== "HEAD") {
        return apiError(405, "method_not_allowed", "Request method is not allowed", false, { Allow: "GET, HEAD" });
      }
      const assetResponse = await env.ASSETS.fetch(request);
      const response = new Response(assetResponse.body, assetResponse);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      return apiError(500, "internal_error", "Internal server error", txtError);
    }
  },
} satisfies ExportedHandler<Env>;
