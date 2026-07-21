import type { NextConfig } from "next";

export function contentSecurityPolicy(
  isDevelopment: boolean = process.env.NODE_ENV === "development"
): string {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    // The Next.js/Turbopack development overlay and fast refresh evaluate code
    // at runtime, which requires 'unsafe-eval'. Production and test builds must
    // never relax the policy this way.
    ...(isDevelopment ? ["'unsafe-eval'"] : [])
  ].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'"
  ].join("; ");
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    root: process.cwd()
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy()
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
          },
          {
            key: "Referrer-Policy",
            value: "no-referrer"
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains"
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff"
          },
          {
            key: "X-Frame-Options",
            value: "DENY"
          }
        ]
      }
    ];
  }
};

export default nextConfig;
