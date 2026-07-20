import { NextRequest, NextResponse } from "next/server";

const REALM = "Sponsor Winback Radar";

export function proxy(request: NextRequest): NextResponse {
  const expectedUser =
    process.env.SPONSOR_RADAR_BASIC_AUTH_USER?.trim() ?? "";
  const expectedPassword =
    process.env.SPONSOR_RADAR_BASIC_AUTH_PASSWORD ?? "";

  if (!expectedUser || !expectedPassword) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "Sponsor Winback Radar access is not configured.",
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8"
          }
        }
      );
    }
    return NextResponse.next();
  }

  const credentials = parseBasicCredentials(
    request.headers.get("authorization")
  );
  if (
    !credentials ||
    !constantTimeEqual(credentials.username, expectedUser) ||
    !constantTimeEqual(credentials.password, expectedPassword)
  ) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`
      }
    });
  }

  const response = NextResponse.next();
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/((?!api/health|_next/static|_next/image|favicon.ico|robots.txt).*)"
  ]
};

function parseBasicCredentials(
  authorization: string | null
): { username: string; password: string } | null {
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(authorization.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
