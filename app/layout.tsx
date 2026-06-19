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
  'Klossete Grand Prix — roll the red cylinder through a foggy obstacle course. Tilt, steer and chase the checkpoints.'

export const metadata: Metadata = {
  metadataBase: new URL('https://klossete.iverfinne.no'),
  title: 'klossete grand prix',
  description: DESCRIPTION,
  applicationName: 'klossete grand prix',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'klossete grand prix' },
  // favicon.ico, icon.svg, apple-icon.png and the opengraph/twitter images are
  // picked up from the app/ directory by Next's file conventions.
  openGraph: {
    type: 'website',
    siteName: 'klossete grand prix',
    title: 'klossete grand prix',
    description: DESCRIPTION,
    url: 'https://klossete.iverfinne.no',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'klossete grand prix',
    description: DESCRIPTION,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // draw edge-to-edge under the status bar / home indicator so the game fills
  // the whole screen instead of leaving a coloured safe-area strip at the top
  viewportFit: 'cover',
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
