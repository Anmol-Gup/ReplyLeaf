import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Knowledge base uploads (up to 10 MB) arrive through a server action.
  experimental: { serverActions: { bodySizeLimit: "11mb" }, agentUpgrade: "security" },
  // Lets `next dev` be opened through an https tunnel (needed to test Embedded Signup,
  // because Meta's popup only works from https pages). Development only; no effect in production.
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.ngrok.io", "*.trycloudflare.com"],
};

export default nextConfig;
