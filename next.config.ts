import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Knowledge base uploads (up to 2 MB) arrive through a server action.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
};

export default nextConfig;
