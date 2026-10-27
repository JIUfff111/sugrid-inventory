import type { NextConfig } from "next";
import os from "node:os";

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

const interfaceHosts = Object.values(os.networkInterfaces()).flatMap(interfaces =>
  (interfaces ?? [])
    .filter(address => address.family === "IPv4" && !address.internal && isPrivateIPv4(address.address))
    .map(address => address.address),
);
const configuredLanHost = process.env.LAN_HOST?.trim();
const allowedDevOrigins = ["127.0.0.1", "localhost", ...interfaceHosts, ...(configuredLanHost ? [configuredLanHost] : [])];

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: [...new Set(allowedDevOrigins)],
  experimental: {
    cpus: 2,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
