import type { NextConfig } from "next";

// Cross-origin isolation gives the worker a 5 µs timer instead of 100 µs, so a single small
// edit can be measured. The page loads nothing from other origins, so it costs nothing.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
