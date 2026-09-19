import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: { "/api/**": ["./backups/latest.json"] },
  outputFileTracingRoot: process.cwd(),
  allowedDevOrigins: ["192.168.100.7"],
};

export default nextConfig;
