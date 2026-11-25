import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
  outputFileTracingRoot: process.cwd(),
  allowedDevOrigins: ["192.168.100.7"],
};

export default nextConfig;
