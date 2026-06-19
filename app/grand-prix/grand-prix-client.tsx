"use client"

import dynamic from "next/dynamic"

// WebGL + canvas-built textures only work in the browser, so load the whole
// racing module client-side with no SSR pass.
const GrandPrix = dynamic(() => import("@/components/racing/GrandPrix"), {
  ssr: false,
  loading: () => <div className="h-dvh w-full" style={{ background: "#d9d3c7" }} />,
})

export default function GrandPrixClient() {
  return <GrandPrix />
}
