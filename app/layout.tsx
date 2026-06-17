import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

const DESCRIPTION =
  'An interactive physics sandbox of realistic wooden building blocks. Drag, slide and throw the blocks around.'

export const metadata: Metadata = {
  metadataBase: new URL('https://klossete.iverfinne.no'),
  title: 'kl.oss.ete',
  description: DESCRIPTION,
  applicationName: 'kl.oss.ete',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'kl.oss.ete' },
  // favicon.ico, icon.svg, apple-icon.png and the opengraph/twitter images are
  // picked up from the app/ directory by Next's file conventions.
  openGraph: {
    type: 'website',
    siteName: 'kl.oss.ete',
    title: 'kl.oss.ete',
    description: DESCRIPTION,
    url: 'https://klossete.iverfinne.no',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'kl.oss.ete',
    description: DESCRIPTION,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  colorScheme: 'light',
  themeColor: '#f6f2ea',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} bg-[#f6f2ea]`}>
      <body className="overflow-hidden bg-[#f6f2ea] font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
