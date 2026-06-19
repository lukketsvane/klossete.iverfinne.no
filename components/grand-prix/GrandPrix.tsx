"use client"

import { Suspense, useCallback, useState } from "react"
import { Canvas } from "@react-three/fiber"
import { ContactShadows } from "@react-three/drei"
import { EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing"
import { ToneMappingMode } from "postprocessing"
import { Physics } from "@react-three/rapier"
import { Hud, type Phase } from "./Hud"
import { Racer } from "./Racer"
import { Track } from "./Track"
import { useControls } from "./useControls"
import { useMusic } from "./useMusic"
import { useRef } from "react"

const FOG = "#e7e0d2"
const GRAVITY: [number, number, number] = [0, -22, 0]

export default function GrandPrix() {
  const [phase, setPhase] = useState<Phase>("ready")
  const [cpHit, setCpHit] = useState(0)
  const [resetToken, setResetToken] = useState(0)
  const [startAt, setStartAt] = useState(0)
  const [finishAt, setFinishAt] = useState(0)
  const [tiltEnabled, setTiltEnabled] = useState(false)

  const { steer, drag } = useControls(tiltEnabled)
  const { musicOn, startMusic, toggleMusic } = useMusic()
  const speedRef = useRef(0)

  const start = useCallback(() => {
    setResetToken((n) => n + 1)
    setCpHit(0)
    setStartAt(Date.now())
    setPhase("racing")
    startMusic()
  }, [startMusic])

  const restart = useCallback(() => {
    setResetToken((n) => n + 1)
    setCpHit(0)
    setPhase("ready")
  }, [])

  const onCheckpoint = useCallback((index: number) => setCpHit((c) => Math.max(c, index)), [])
  const onFinish = useCallback(() => {
    setFinishAt(Date.now())
    setPhase("won")
  }, [])
  const onFall = useCallback(() => {}, [])

  const toggleTilt = useCallback(async () => {
    if (tiltEnabled) {
      setTiltEnabled(false)
      return
    }
    const DOE = (typeof window !== "undefined" ? (window as any).DeviceOrientationEvent : null) as any
    try {
      if (DOE && typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission()
        if (res !== "granted") return
      }
    } catch {
      return
    }
    setTiltEnabled(true)
  }, [tiltEnabled])

  return (
    <main className="relative h-dvh w-full overflow-hidden" style={{ background: FOG }}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ fov: 55, near: 0.1, far: 200, position: [0, 6, -10] }}
        gl={{ antialias: false }}
      >
        <color attach="background" args={[FOG]} />
        <fog attach="fog" args={[FOG, 14, 70]} />

        <ambientLight intensity={0.55} color="#f1ece2" />
        <directionalLight
          position={[-12, 26, -8]}
          intensity={2.4}
          color="#fff4e2"
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-near={1}
          shadow-camera-far={90}
          shadow-camera-left={-40}
          shadow-camera-right={40}
          shadow-camera-top={40}
          shadow-camera-bottom={-40}
          shadow-bias={-0.0004}
        />

        <Suspense fallback={null}>
          {/* fixed timestep: a frame-time spike (e.g. a heavy GLB decode) can't
              produce a giant integration step that launches the cylinder */}
          <Physics gravity={GRAVITY} timeStep={1 / 60}>
            <Track />
            <Racer
              running={phase === "racing"}
              resetToken={resetToken}
              steer={steer}
              speedRef={speedRef}
              onCheckpoint={onCheckpoint}
              onFinish={onFinish}
              onFall={onFall}
            />
          </Physics>
          <ContactShadows
            position={[0, -1.49, 0]}
            scale={120}
            far={6}
            blur={2.5}
            opacity={0.35}
            color="#6b6155"
          />
        </Suspense>

        <EffectComposer multisampling={0}>
          <N8AO aoRadius={0.9} intensity={1.1} distanceFalloff={1} halfRes color="#2a241a" />
          <Vignette offset={0.32} darkness={0.22} />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          <SMAA />
        </EffectComposer>
      </Canvas>

      <Hud
        phase={phase}
        cpHit={cpHit}
        startAt={startAt}
        finishAt={finishAt}
        tiltEnabled={tiltEnabled}
        musicOn={musicOn}
        speedRef={speedRef}
        drag={drag}
        onStart={start}
        onRestart={restart}
        onToggleTilt={toggleTilt}
        onToggleMusic={toggleMusic}
      />
    </main>
  )
}
