import { ImageResponse } from 'next/og'

export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export const alt = 'kl.oss.ete — an interactive physics sandbox of wooden blocks'

export default function OpengraphImage() {
  const blocks: { c: string; w: number; h: number }[] = [
    { c: '#3f9ec9', w: 150, h: 150 },
    { c: '#e07b22', w: 170, h: 120 },
    { c: '#2f63cc', w: 120, h: 200 },
    { c: '#c83a2e', w: 110, h: 110 },
  ]
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#f1ece2',
          padding: '90px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 96, fontWeight: 800, color: '#1c1a17', letterSpacing: '-2px' }}>
            kl.oss.ete
          </div>
          <div style={{ fontSize: 40, color: '#6b655b', marginTop: 16 }}>
            an interactive physics sandbox of wooden blocks
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28 }}>
          {blocks.map((b, i) => (
            <div
              key={i}
              style={{ width: b.w, height: b.h, borderRadius: 18, background: b.c }}
            />
          ))}
        </div>
      </div>
    ),
    { ...size },
  )
}
