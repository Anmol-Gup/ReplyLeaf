import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Knowledge base uploads (up to 3 MB per file) arrive through a server action; 4 MB leaves room for the form fields.
  experimental: { serverActions: { bodySizeLimit: "4mb" }, agentUpgrade: "security" },
  // The client guide is a plain page in public/guide.html, served at /guide.
  async rewrites() { return [{ source: "/guide", destination: "/guide.html" }]; },
  // Lets `next dev` be opened through an https tunnel (needed to test Embedded Signup,
  // because Meta's popup only works from https pages). Development only; no effect in production.
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.ngrok.io", "*.trycloudflare.com"],
};

export default nextConfig;
