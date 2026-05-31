/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pdf-parse', 'mammoth'],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
}

module.exports = nextConfig
