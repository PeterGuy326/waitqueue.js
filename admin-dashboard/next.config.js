/** @type {import('next').NextConfig} */
const isPages = process.env.WAITQUEUE_PAGES_BUILD === 'true';
const pagesBasePath = process.env.PAGES_BASE_PATH || '/waitqueue.js';

module.exports = {
  output: isPages ? 'export' : 'standalone',
  basePath: isPages ? pagesBasePath : '',
  trailingSlash: isPages,
  pageExtensions: isPages ? ['tsx'] : ['tsx', 'ts'],
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ['127.0.0.1'],
  ...(isPages
    ? {}
    : {
        async rewrites() {
          return [
            {
              source: '/waitqueue/:path*',
              destination: '/api/waitqueue/:path*',
            },
          ];
        },
      }),
};
