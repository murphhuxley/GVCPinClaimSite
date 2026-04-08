/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "sl1vlqqspml5zngx.public.blob.vercel-storage.com",
      },
    ],
  },
};

module.exports = nextConfig;
