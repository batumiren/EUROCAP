import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: { "/*": ["./backups/latest.json"] },
  allowedDevOrigins: ["192.168.100.7"],
};

export default nextConfig;
