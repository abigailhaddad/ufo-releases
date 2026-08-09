import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static HTML export, so a static host can serve this instead of Vercel's
  // Next.js runtime. Nothing here needs a server: two pages, no API routes, no
  // server actions, no dynamic segments. lib/r2.ts only builds R2 URLs -- the
  // browser fetches those directly.
  output: "export",
  trailingSlash: true,
  // next/image's optimiser is a server feature; export refuses to build with it.
  images: { unoptimized: true },
};

export default nextConfig;
