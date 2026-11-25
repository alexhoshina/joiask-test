import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  // Pre-render every route for the application Worker's static assets.
  output: 'export',
  basePath: '/docs',
  // The image optimizer needs a server; MDX images are served as-is.
  images: { unoptimized: true },
  reactStrictMode: true,
  // docs/ is nested in the application repository, which has its own lockfiles.
  turbopack: { root: import.meta.dirname }
}

export default withMDX(config)
