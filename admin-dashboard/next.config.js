/** @type {import('next').NextConfig} */
const apiOrigin = (process.env.WAITQUEUE_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

module.exports = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/waitqueue/:path*',
        destination: `${apiOrigin}/waitqueue/:path*`,
      },
    ];
  },
};
