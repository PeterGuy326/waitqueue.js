/** @type {import('next').NextConfig} */
const apiOrigin = (process.env.WAITQUEUE_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

module.exports = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ['127.0.0.1'],
  async rewrites() {
    return [
      {
        source: '/waitqueue/:path*',
        destination: `${apiOrigin}/waitqueue/:path*`,
      },
    ];
  },
};
