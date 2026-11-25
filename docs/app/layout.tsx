import type { Metadata } from 'next'
import '@fontsource-variable/inter'
import type { ReactNode } from 'react'
import { Provider } from '@/components/provider'
import { siteDescription, siteName, siteURL } from '@/lib/shared'
import './global.css'



export const metadata: Metadata = {
  metadataBase: siteURL ? new URL(siteURL) : undefined,
  title: { default: siteName, template: `%s | ${siteName}` },
  description: siteDescription,
  icons: { icon: '/docs/favicon.png', apple: '/docs/favicon.png' }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" style={{fontFamily: '"Inter Variable", sans-serif'}} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  )
}
