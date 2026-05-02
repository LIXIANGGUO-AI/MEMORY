import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls, useTexture } from '@react-three/drei'
import gsap from 'gsap'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { Route, Routes, useNavigate } from 'react-router-dom'
import {
  AdditiveBlending,
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three'
import { Album } from './Album'
import { addCityAsync, listCitiesAsync, removeCityAsync } from './data/cityStore'
import { supabaseEnabled } from './lib/supabase'
import { defaultCities, type CityRecord } from './data/cities'
import { geocodePlaceName } from './services/geocode'

/**
 * WGS84-style lat/lon (degrees) → point on the same sphere as `SphereGeometry`:
 * u = (lon + 180) / 360, v = (90 − lat) / 180, then three.js vertex math
 * (see `three/src/geometries/SphereGeometry.js`: cos/sin of phiStart+u*phiLength, etc.).
 * This matches equirectangular textures mapped with default sphere UVs.
 */
function latLonToVector3(latDeg: number, lonDeg: number, radius: number) {
  const u = MathUtils.euclideanModulo((lonDeg + 180) / 360, 1)
  const v = MathUtils.clamp((90 - latDeg) / 180, 0, 1)
  const azimuth = u * Math.PI * 2
  const polar = v * Math.PI
  const sinPolar = Math.sin(polar)
  return new Vector3(
    -radius * Math.cos(azimuth) * sinPolar,
    radius * Math.cos(polar),
    radius * Math.sin(azimuth) * sinPolar,
  )
}

/** Meshes that only visuals — exclude from R3F raycast so city markers receive clicks. */
function noopRaycast() {}

function splitCityLabel(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return { primary: '', secondary: '' }

  const slashParts = trimmed
    .split(/[|/]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (slashParts.length >= 2) {
    return {
      primary: slashParts[0]!,
      secondary: slashParts.slice(1).join(' '),
    }
  }

  const hasLatin = /[A-Za-z]/.test(trimmed)
  const hasCjk = /[\u3400-\u9fff]/.test(trimmed)
  if (hasLatin && hasCjk) {
    const latin = (trimmed.match(/[A-Za-z][A-Za-z\s'-]*/g) ?? []).join(' ').replace(/\s+/g, ' ').trim()
    const cjk = (trimmed.match(/[\u3400-\u9fff]+/g) ?? []).join(' ').trim()
    if (latin && cjk) {
      return { primary: latin, secondary: cjk }
    }
  }

  return { primary: trimmed, secondary: '' }
}

function extractNeteaseSongId(input: string) {
  const raw = input.trim()
  if (!raw) return null
  const idFromRaw = raw.match(/(?:^|[?&#])id=(\d{5,})/i)?.[1]
  if (idFromRaw) return idFromRaw
  try {
    const u = new URL(raw)
    const id = u.searchParams.get('id')
    if (id && /^\d{5,}$/.test(id)) return id
  } catch {
    // ignore malformed URL, fallback to direct id match
  }
  if (/^\d{5,}$/.test(raw)) return raw
  return null
}

function FlyToController({
  flyCity,
  earthGroupRef,
  controlsRef,
  spinPausedRef,
  onFlightTweenComplete,
}: {
  flyCity: CityRecord | null
  earthGroupRef: RefObject<Group | null>
  controlsRef: RefObject<OrbitControlsImpl | null>
  spinPausedRef: MutableRefObject<boolean>
  onFlightTweenComplete: (cityId: string) => void
}) {
  const { camera } = useThree()
  const onCompleteRef = useRef(onFlightTweenComplete)
  onCompleteRef.current = onFlightTweenComplete

  useEffect(() => {
    if (!flyCity || !earthGroupRef.current) return

    spinPausedRef.current = true
    const ctrl = controlsRef.current
    if (ctrl) {
      ctrl.enabled = false
      ctrl.autoRotate = false
    }

    const earth = earthGroupRef.current
    const u = latLonToVector3(flyCity.lat, flyCity.lon, 1).normalize()
    const qStart = earth.quaternion.clone()
    const qEnd = new Quaternion().setFromUnitVectors(u, new Vector3(0, 0, 1))

    const camStart = camera.position.clone()
    // Keep a little distance at destination to avoid over-zoom blur.
    const camEnd = new Vector3(0, 0, 1.95)
    const cityId = flyCity.id

    const prog = { t: 0 }
    const tween = gsap.to(prog, {
      t: 1,
      duration: 1.35,
      ease: 'power3.inOut',
      onUpdate: () => {
        const t = prog.t
        earth.quaternion.slerpQuaternions(qStart, qEnd, t)
        camera.position.lerpVectors(camStart, camEnd, t)
        camera.lookAt(0, 0, 0)
      },
      onComplete: () => {
        onCompleteRef.current(cityId)
      },
    })

    return () => {
      tween.kill()
    }
  }, [flyCity?.id, earthGroupRef, controlsRef, spinPausedRef, camera])

  return null
}

function GalaxyBackground() {
  const skyMaterial = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        toneMapped: false,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uTime;
          varying vec3 vDir;

          float hash(vec3 p) {
            p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
            p *= 17.0;
            return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
          }

          float noise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n000 = hash(i + vec3(0.0, 0.0, 0.0));
            float n100 = hash(i + vec3(1.0, 0.0, 0.0));
            float n010 = hash(i + vec3(0.0, 1.0, 0.0));
            float n110 = hash(i + vec3(1.0, 1.0, 0.0));
            float n001 = hash(i + vec3(0.0, 0.0, 1.0));
            float n101 = hash(i + vec3(1.0, 0.0, 1.0));
            float n011 = hash(i + vec3(0.0, 1.0, 1.0));
            float n111 = hash(i + vec3(1.0, 1.0, 1.0));
            return mix(
              mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
              mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
              f.z
            );
          }

          float fbm(vec3 p) {
            float v = 0.0;
            float a = 0.5;
            for (int i = 0; i < 5; i++) {
              v += a * noise(p);
              p *= 2.05;
              a *= 0.5;
            }
            return v;
          }

          float starLayer(vec3 dir, float density, float scale, float threshold) {
            vec3 p = dir * scale;
            vec3 cell = floor(p);
            float h = hash(cell);
            if (h < threshold) return 0.0;
            vec3 inCell = fract(p) - 0.5;
            float d = length(inCell);
            float twinkle = 0.6 + 0.4 * sin(uTime * (2.0 + h * 5.0) + h * 30.0);
            float core = smoothstep(0.36, 0.0, d);
            float halo = smoothstep(0.5, 0.0, d) * 0.35;
            return (core + halo) * twinkle * density;
          }

          void main() {
            vec3 dir = normalize(vDir);

            // Deeper, dreamier void (darker base).
            float vert = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 base = mix(vec3(0.002, 0.003, 0.01), vec3(0.02, 0.025, 0.08), vert);

            // Soft purple / indigo nebula (subtle, not loud).
            vec3 nebDir = dir + vec3(0.0, uTime * 0.003, uTime * 0.0025);
            float neb = fbm(nebDir * 2.4);
            float dust = fbm(nebDir * 5.2 + 4.0);
            float dream = fbm(nebDir * 1.6 + vec3(12.0));
            vec3 nebColor = mix(vec3(0.04, 0.06, 0.18), vec3(0.28, 0.14, 0.42), dust);
            nebColor = mix(nebColor, vec3(0.35, 0.2, 0.38), dream * 0.35);
            base += pow(neb, 2.8) * nebColor * 0.32;

            // Milky Way band - dimmer, more violet-milk than cyan-white.
            vec3 axis = normalize(vec3(0.32, 0.78, 0.55));
            float band = 1.0 - abs(dot(dir, axis));
            float bandGlow = pow(clamp(band, 0.0, 1.0), 5.2);
            float bandNoise = fbm(dir * 8.0 + vec3(uTime * 0.008));
            base += bandGlow * (0.22 + bandNoise * 0.28) * vec3(0.38, 0.42, 0.72);

            // Stars - fewer / softer points, slight lavender tint (dreamy).
            float stars = 0.0;
            stars += starLayer(dir, 0.85, 240.0, 0.987);
            stars += starLayer(dir, 0.55, 110.0, 0.975);
            stars += starLayer(dir, 0.35, 48.0, 0.945);
            base += stars * vec3(0.78, 0.74, 0.95);

            // Vignette — keep frame darker at edges.
            base *= 0.78 + 0.22 * smoothstep(1.0, 0.35, length(dir.xy));

            gl_FragColor = vec4(base, 1.0);
          }
        `,
      }),
    [],
  )

  useFrame(({ clock }) => {
    skyMaterial.uniforms.uTime.value = clock.getElapsedTime()
  })

  return (
    <mesh scale={-1} raycast={noopRaycast}>
      <sphereGeometry args={[60, 64, 64]} />
      <primitive object={skyMaterial} attach="material" />
    </mesh>
  )
}

function AtmosphericGlow({
  flashRef,
}: {
  flashRef: { current: number }
}) {
  const innerMaterial = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uInner: { value: new Color('#7fb6ff') },
          uOuter: { value: new Color('#1d3766') },
          uFlash: { value: 0 },
          uVisibility: { value: 1 },
          uPower: { value: 3.2 },
          uIntensity: { value: 0.55 },
        },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vViewDir;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vNormal = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - worldPos.xyz);
            gl_Position = projectionMatrix * viewMatrix * worldPos;
          }
        `,
        fragmentShader: `
          uniform vec3 uInner;
          uniform vec3 uOuter;
          uniform float uFlash;
          uniform float uVisibility;
          uniform float uPower;
          uniform float uIntensity;
          varying vec3 vNormal;
          varying vec3 vViewDir;
          void main() {
            float facing = max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
            float fresnel = pow(1.0 - facing, uPower);
            vec3 col = mix(uOuter, uInner, fresnel);
            float a = (fresnel * uIntensity + uFlash * 0.18 * (1.0 - facing * 0.5)) * uVisibility;
            gl_FragColor = vec4(col, a);
          }
        `,
      }),
    [],
  )

  const outerMaterial = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uColor: { value: new Color('#406a9c') },
          uFlash: { value: 0 },
          uVisibility: { value: 1 },
        },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vViewDir;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vNormal = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - worldPos.xyz);
            gl_Position = projectionMatrix * viewMatrix * worldPos;
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          uniform float uFlash;
          uniform float uVisibility;
          varying vec3 vNormal;
          varying vec3 vViewDir;
          void main() {
            float facing = max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
            float fresnel = pow(1.0 - facing, 2.4);
            float alpha = (fresnel * 0.18 + uFlash * 0.08) * uVisibility;
            gl_FragColor = vec4(uColor, alpha);
          }
        `,
      }),
    [],
  )

  useFrame(({ camera }) => {
    const d = camera.position.length()
    // Fade atmosphere out when entering close-up mode.
    const visibility = MathUtils.clamp((d - 1.5) / 0.22, 0, 1)
    innerMaterial.uniforms.uFlash.value = flashRef.current
    innerMaterial.uniforms.uVisibility.value = visibility
    outerMaterial.uniforms.uFlash.value = flashRef.current
    outerMaterial.uniforms.uVisibility.value = visibility
  })

  return (
    <group>
      <mesh raycast={noopRaycast}>
        <sphereGeometry args={[1.025, 96, 96]} />
        <primitive object={innerMaterial} attach="material" side={DoubleSide} />
      </mesh>
      <mesh raycast={noopRaycast}>
        <sphereGeometry args={[1.09, 96, 96]} />
        <primitive object={outerMaterial} attach="material" side={BackSide} />
      </mesh>
    </group>
  )
}

function CityMarkerItem({
  city,
  hovered,
  showLabel,
  onHover,
  onCityClick,
  onMarkerReady,
}: {
  city: CityRecord
  hovered: boolean
  showLabel: boolean
  onHover: (id: string | null) => void
  onCityClick: (city: CityRecord) => void
  onMarkerReady: (
    id: string,
    marker: {
      group: Group
      labelEl: HTMLDivElement
      nameEl: HTMLDivElement
    } | null,
  ) => void
}) {
  const groupRef = useRef<Group>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!groupRef.current) return
    gsap.to(groupRef.current.scale, {
      x: hovered ? 1.4 : 1,
      y: hovered ? 1.4 : 1,
      z: hovered ? 1.4 : 1,
      duration: 0.35,
      ease: 'power2.out',
    })
  }, [hovered])

  useEffect(() => {
    if (groupRef.current && labelRef.current && nameRef.current) {
      onMarkerReady(city.id, {
        group: groupRef.current,
        labelEl: labelRef.current,
        nameEl: nameRef.current,
      })
    }
    return () => {
      onMarkerReady(city.id, null)
    }
  }, [city.id, onMarkerReady])

  const dir = useMemo(() => latLonToVector3(city.lat, city.lon, 1).normalize(), [city.lat, city.lon])
  // Keep marker almost on the globe surface; tiny lift avoids z-fighting.
  const pos = useMemo(() => dir.clone().multiplyScalar(1.004), [dir])
  // Labels stay very close to anchor to avoid "floating in space" look.
  const labelLift = useMemo(() => dir.clone().multiplyScalar(0.008), [dir])
  const nameParts = useMemo(() => splitCityLabel(city.name), [city.name])

  return (
    <group
      ref={groupRef}
      position={pos}
      onClick={(e) => {
        e.stopPropagation()
        onCityClick(city)
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        document.body.style.cursor = 'pointer'
        onHover(city.id)
      }}
      onPointerOut={(e) => {
        e.stopPropagation()
        document.body.style.cursor = 'auto'
        onHover(null)
      }}
    >
      <mesh visible={false}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
      <group position={labelLift}>
        {showLabel && (
          <Html center distanceFactor={8}>
            <div
              ref={labelRef}
              className={`city-label ${hovered ? 'city-label--hover' : ''}`}
              role="presentation"
              onClick={(e) => {
                e.stopPropagation()
                onCityClick(city)
              }}
              onPointerEnter={(e) => {
                e.stopPropagation()
                document.body.style.cursor = 'pointer'
                onHover(city.id)
              }}
              onPointerLeave={(e) => {
                e.stopPropagation()
                document.body.style.cursor = 'auto'
                onHover(null)
              }}
            >
              <div ref={nameRef} className="city-name">
                <span className="city-name-primary">{nameParts.primary}</span>
                {nameParts.secondary ? <span className="city-name-secondary">{nameParts.secondary}</span> : null}
              </div>
              <div className="city-dot-wrapper" aria-hidden>
                <div className="city-dot-outer" />
                <div className="city-dot-inner" />
              </div>
            </div>
          </Html>
        )}
      </group>
    </group>
  )
}

function CityMarkers({
  cities,
  hoveredCityId,
  onHover,
  onCityClick,
}: {
  cities: CityRecord[]
  hoveredCityId: string | null
  onHover: (id: string | null) => void
  onCityClick: (city: CityRecord) => void
}) {
  const markerMapRef = useRef(
    new Map<
      string,
      {
        group: Group
        labelEl: HTMLDivElement
        nameEl: HTMLDivElement
      }
    >(),
  )

  const onMarkerReady = useCallback(
    (
      id: string,
      marker: {
        group: Group
        labelEl: HTMLDivElement
        nameEl: HTMLDivElement
      } | null,
    ) => {
      if (!marker) {
        markerMapRef.current.delete(id)
        return
      }
      markerMapRef.current.set(id, marker)
    },
    [],
  )

  useFrame(({ camera, size }) => {
    const distance = camera.position.length()
    const nearDistance = 1.05
    const farDistance = 8
    const distanceT = MathUtils.clamp((distance - nearDistance) / (farDistance - nearDistance), 0, 1)
    const closeUpMode = distance < 1.5
    // Keep labels compact across zoom levels to reduce overlap pressure.
    const scale = MathUtils.lerp(0.34, 0.54, distanceT)
    const fontPx = Math.round(MathUtils.lerp(4, 7, distanceT))
    const baseTextOpacity = distance > 4.2 ? 0 : distance > 3.1 ? 0.38 : distance > 2.2 ? 0.66 : 0.95
    const screenPositions: Array<{
      id: string
      x: number
      y: number
      z: number
    }> = []
    const camDir = camera.position.clone().normalize()
    const worldPos = new Vector3()
    const projected = new Vector3()

    for (const city of cities) {
      const marker = markerMapRef.current.get(city.id)
      if (!marker) continue

      marker.labelEl.style.setProperty('--city-font-size', `${fontPx}px`)
      marker.labelEl.style.transform = `scale(${scale.toFixed(3)})`
      marker.labelEl.style.transformOrigin = 'center top'

      marker.group.getWorldPosition(worldPos)
      const facing = worldPos.normalize().dot(camDir)
      if (facing <= 0) {
        marker.labelEl.style.display = 'none'
        continue
      }

      marker.labelEl.style.display = 'flex'
      projected.copy(worldPos).project(camera)
      screenPositions.push({
        id: city.id,
        x: ((projected.x + 1) / 2) * size.width,
        y: ((-projected.y + 1) / 2) * size.height,
        z: projected.z,
      })
    }

    const opacityById = new Map<string, number>()
    const priorityById = new Map<string, number>()
    const cx = size.width * 0.5
    const cy = size.height * 0.5
    for (const p of screenPositions) {
      if (hoveredCityId === p.id) {
        priorityById.set(p.id, 100000)
        continue
      }
      const centerDist = Math.hypot(p.x - cx, p.y - cy)
      const centerScore = Math.max(0, 1200 - centerDist)
      const depthScore = Math.max(0, (1 - p.z) * 700)
      priorityById.set(p.id, centerScore + depthScore)
    }
    if (closeUpMode) {
      for (const p of screenPositions) opacityById.set(p.id, 1)
    } else {
      const hideThreshold = 108 * scale
      const fadeThreshold = 172 * scale
      for (const p of screenPositions) opacityById.set(p.id, baseTextOpacity)

      for (let i = 0; i < screenPositions.length; i += 1) {
        for (let j = i + 1; j < screenPositions.length; j += 1) {
          const a = screenPositions[i]!
          const b = screenPositions[j]!
          const dist = Math.hypot(a.x - b.x, a.y - b.y)
          const aPriority = priorityById.get(a.id) ?? 0
          const bPriority = priorityById.get(b.id) ?? 0
          const hideId = aPriority >= bPriority ? b.id : a.id
          if (dist < hideThreshold) {
            opacityById.set(hideId, Math.min(opacityById.get(hideId) ?? 1, 0))
          } else if (dist < fadeThreshold) {
            opacityById.set(hideId, Math.min(opacityById.get(hideId) ?? 1, 0.3))
          }
        }
      }
    }

    if (hoveredCityId && opacityById.has(hoveredCityId)) {
      opacityById.set(hoveredCityId, 1)
    }

    for (const city of cities) {
      const marker = markerMapRef.current.get(city.id)
      if (!marker || marker.labelEl.style.display === 'none') continue
      marker.nameEl.style.opacity = `${opacityById.get(city.id) ?? baseTextOpacity}`
    }
  })

  return (
    <>
      {cities.map((city) => (
        <CityMarkerItem
          key={city.id}
          city={city}
          hovered={hoveredCityId === city.id}
          showLabel
          onHover={onHover}
          onCityClick={onCityClick}
          onMarkerReady={onMarkerReady}
        />
      ))}
    </>
  )
}

function Globe({
  flashRef,
  earthGroupRef,
  spinPausedRef,
  cities,
  hoveredCityId,
  onHoverCity,
  onCityClick,
}: {
  flashRef: { current: number }
  earthGroupRef: RefObject<Group | null>
  spinPausedRef: MutableRefObject<boolean>
  cities: CityRecord[]
  hoveredCityId: string | null
  onHoverCity: (id: string | null) => void
  onCityClick: (city: CityRecord) => void
}) {
  const { gl } = useThree()
  const cloudRef = useRef<Mesh>(null)
  const cloudFastRef = useRef<Mesh>(null)
  const lightningLightRef = useRef<DirectionalLight>(null)
  const [earthDayMap, cloudMap, earthNightMap] = useTexture([
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg',
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_clouds_1024.png',
    'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_lights_2048.png',
  ])
  const sunDirection = useMemo(() => new Vector3(1.8, 0.8, 1.5).normalize(), [])
  const cameraSunLocal = useMemo(() => new Vector3(0.85, 0.55, 1).normalize(), [])
  const cameraSunWorld = useMemo(() => new Vector3(), [])
  earthDayMap.colorSpace = SRGBColorSpace
  earthNightMap.colorSpace = SRGBColorSpace
  cloudMap.colorSpace = SRGBColorSpace
  cloudMap.wrapS = RepeatWrapping
  cloudMap.wrapT = RepeatWrapping
  const maxAnisotropy = gl.capabilities.getMaxAnisotropy()
  earthDayMap.anisotropy = maxAnisotropy
  earthNightMap.anisotropy = maxAnisotropy
  cloudMap.anisotropy = Math.max(1, Math.floor(maxAnisotropy * 0.5))

  const globeMaterial = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uDayMap: { value: earthDayMap as Texture },
          uNightMap: { value: earthNightMap as Texture },
          uSunDirection: { value: sunDirection.clone() },
          uAmbient: { value: 0.24 },
          uFlash: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vWorldNormal;
          void main() {
            vUv = uv;
            vWorldNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uDayMap;
          uniform sampler2D uNightMap;
          uniform vec3 uSunDirection;
          uniform float uAmbient;
          uniform float uFlash;
          varying vec2 vUv;
          varying vec3 vWorldNormal;
          void main() {
            vec3 dayColor = texture2D(uDayMap, vUv).rgb;
            vec3 nightLights = texture2D(uNightMap, vUv).rgb;
            float nDotL = dot(normalize(vWorldNormal), normalize(uSunDirection));
            // Shift terminator so lit area is closer to ~2/3 globe.
            float dayFactor = smoothstep(0.06, 0.46, nDotL);
            float nightFactor = smoothstep(0.38, -0.32, nDotL);

            vec3 litDay = dayColor * max(uAmbient, nDotL * 1.08 + uAmbient);

            // Brighter night hemisphere base (slightly lift oceans / dark land).
            vec3 nightAmbient = vec3(0.028, 0.034, 0.055) * nightFactor;

            // City lights: boost + warm sodium / amber core where bright (realistic glow).
            float cityMag = max(max(nightLights.r, nightLights.g), nightLights.b);
            vec3 boosted = pow(nightLights, vec3(0.52)) * 2.0;
            vec3 warmCore = boosted * vec3(1.35, 0.88, 0.42);
            vec3 coolFill = boosted * vec3(0.75, 0.88, 1.0);
            vec3 cityGlow = mix(coolFill, warmCore, smoothstep(0.05, 0.28, cityMag));
            cityGlow += nightLights * vec3(1.1, 0.95, 0.8) * 0.35 * smoothstep(0.02, 0.2, cityMag);

            vec3 litNight = (cityGlow * 3.15 + nightAmbient) * nightFactor;
            vec3 twilight = vec3(0.1, 0.17, 0.3) * smoothstep(-0.2, 0.08, nDotL) * (1.0 - dayFactor);
            vec3 color = mix(litNight + twilight, litDay, dayFactor);
            color += vec3(0.18, 0.24, 0.45) * uFlash * nightFactor;
            gl_FragColor = vec4(color, 1.0);
          }
        `,
      }),
    [earthDayMap, earthNightMap, sunDirection],
  )

  useFrame(({ camera }, delta) => {
    if (!earthGroupRef.current || !cloudRef.current || !cloudFastRef.current) return
    cameraSunWorld.copy(cameraSunLocal).applyQuaternion(camera.quaternion).normalize()
    globeMaterial.uniforms.uSunDirection.value.copy(cameraSunWorld)
    globeMaterial.uniforms.uFlash.value = flashRef.current
    if (!spinPausedRef.current) {
      earthGroupRef.current.rotation.y += delta * 0.06
    }
    cloudRef.current.rotation.y += delta * 0.075
    cloudRef.current.rotation.x = Math.sin(performance.now() * 0.00009) * 0.04
    cloudFastRef.current.rotation.y -= delta * 0.045
    cloudFastRef.current.rotation.x = Math.cos(performance.now() * 0.00012) * 0.03
    if (lightningLightRef.current) {
      lightningLightRef.current.intensity = flashRef.current * 3.6
    }
  })

  return (
    <group ref={earthGroupRef}>
      <mesh raycast={noopRaycast}>
        <sphereGeometry args={[1, 96, 96]} />
        <primitive object={globeMaterial} attach="material" />
      </mesh>
      <CityMarkers
        cities={cities}
        hoveredCityId={hoveredCityId}
        onHover={onHoverCity}
        onCityClick={onCityClick}
      />
      <mesh ref={cloudRef} raycast={noopRaycast}>
        <sphereGeometry args={[1.012, 96, 96]} />
        <meshStandardMaterial
          map={cloudMap}
          transparent
          opacity={0.55}
          depthWrite={false}
          color="#ffffff"
        />
      </mesh>
      <mesh ref={cloudFastRef} raycast={noopRaycast}>
        <sphereGeometry args={[1.022, 96, 96]} />
        <meshStandardMaterial
          map={cloudMap}
          transparent
          opacity={0.18}
          depthWrite={false}
          color="#dde7f2"
          blending={AdditiveBlending}
        />
      </mesh>
      <AtmosphericGlow flashRef={flashRef} />
      <directionalLight
        ref={lightningLightRef}
        position={[1.6, 1.1, 1.2]}
        color="#a9d5ff"
        intensity={0}
      />
    </group>
  )
}

function CameraBoundSunLight() {
  const lightRef = useRef<DirectionalLight>(null)
  const lightLocal = useMemo(() => new Vector3(0.85, 0.55, 1).normalize(), [])
  const lightWorld = useMemo(() => new Vector3(), [])

  useFrame(({ camera }) => {
    if (!lightRef.current) return
    lightWorld.copy(lightLocal).applyQuaternion(camera.quaternion).normalize()
    lightRef.current.position.set(lightWorld.x * 5, lightWorld.y * 5, lightWorld.z * 5)
  })

  return <directionalLight ref={lightRef} intensity={3} color="#ffd29a" />
}

function WeatherDirector({
  flashRef,
}: {
  flashRef: { current: number }
}) {
  const cooldownRef = useRef(2.5)

  useFrame((_, delta) => {
    cooldownRef.current -= delta
    flashRef.current = Math.max(0, flashRef.current - delta * 3.4)

    if (cooldownRef.current <= 0) {
      const burst = 1 + Math.random() * 0.6
      flashRef.current = burst
      cooldownRef.current = 4 + Math.random() * 6
      setTimeout(() => {
        flashRef.current = burst * 0.7
      }, 90)
    }
  })

  return null
}

function GlobePage() {
  const navigate = useNavigate()
  const flashRef = useRef(0)
  const earthGroupRef = useRef<Group>(null)
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const musicInputRef = useRef<HTMLInputElement | null>(null)
  const musicUrlRef = useRef<string | null>(null)
  const spinPausedRef = useRef(false)
  const [cities, setCities] = useState<CityRecord[]>([])
  const [hoveredCityId, setHoveredCityId] = useState<string | null>(null)
  const [flyCity, setFlyCity] = useState<CityRecord | null>(null)
  const [vignetteOpacity, setVignetteOpacity] = useState(0)
  const [showCreateCity, setShowCreateCity] = useState(false)
  const [newCityName, setNewCityName] = useState('')
  const [newCityLat, setNewCityLat] = useState('')
  const [newCityLon, setNewCityLon] = useState('')
  const [geocodeLoading, setGeocodeLoading] = useState(false)
  const [createCityError, setCreateCityError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CityRecord | null>(null)
  const [deleteCityError, setDeleteCityError] = useState<string | null>(null)
  const [musicName, setMusicName] = useState('No track selected')
  const [musicLinkInput, setMusicLinkInput] = useState('')
  const [musicUrl, setMusicUrl] = useState<string | null>(null)
  const [musicPlaying, setMusicPlaying] = useState(false)
  const [musicCurrent, setMusicCurrent] = useState(0)
  const [musicDuration, setMusicDuration] = useState(0)
  const [musicVolume, setMusicVolume] = useState(0.7)
  const [musicLoop, setMusicLoop] = useState(false)
  const [musicError, setMusicError] = useState<string | null>(null)
  const defaultCityIdSet = useMemo(() => new Set(defaultCities.map((c) => c.id)), [])

  useEffect(() => {
    let alive = true
    void listCitiesAsync().then((next) => {
      if (!alive) return
      setCities(next)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    return () => {
      if (musicUrlRef.current) {
        URL.revokeObjectURL(musicUrlRef.current)
        musicUrlRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = musicVolume
    audio.loop = musicLoop
  }, [musicVolume, musicLoop])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onLoaded = () => {
      setMusicDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    }
    const onTime = () => {
      setMusicCurrent(audio.currentTime || 0)
    }
    const onPlay = () => setMusicPlaying(true)
    const onPause = () => setMusicPlaying(false)
    const onEnded = () => setMusicPlaying(false)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [])

  const formatTime = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
    const total = Math.floor(seconds)
    const mm = Math.floor(total / 60)
    const ss = total % 60
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }, [])

  const handleCityClick = useCallback((city: CityRecord) => {
    spinPausedRef.current = true
    setFlyCity(city)
  }, [])

  const resolveCoordinates = useCallback(async () => {
    const q = newCityName.trim()
    if (!q) {
      setCreateCityError('请先输入地点名')
      return
    }
    try {
      setCreateCityError(null)
      setGeocodeLoading(true)
      const r = await geocodePlaceName(q)
      setNewCityLat(r.lat.toFixed(6))
      setNewCityLon(r.lon.toFixed(6))
    } catch (err) {
      setCreateCityError(err instanceof Error ? err.message : '解析坐标失败')
    } finally {
      setGeocodeLoading(false)
    }
  }, [newCityName])

  const saveCity = useCallback(async () => {
    try {
      setCreateCityError(null)
      const lat = Number(newCityLat)
      const lon = Number(newCityLon)
      const { cloudSaved } = await addCityAsync({
        name: newCityName,
        lat,
        lon,
      })
      const next = await listCitiesAsync()
      setCities(next)
      if (!cloudSaved && supabaseEnabled) {
        setCreateCityError(
          '已保存到本机，但未写入 Supabase。请确认 .env 里已填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY，保存后重启 npm run dev；并按 F12 查看控制台 [memory] Supabase 报错。',
        )
        return
      }
      setShowCreateCity(false)
      setNewCityName('')
      setNewCityLat('')
      setNewCityLon('')
    } catch (err) {
      setCreateCityError(err instanceof Error ? err.message : '创建地点失败')
    }
  }, [newCityLat, newCityLon, newCityName])

  const requestDeleteCity = useCallback((city: CityRecord) => {
    setDeleteCityError(null)
    setDeleteTarget(city)
  }, [])

  const confirmDeleteCity = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await removeCityAsync(deleteTarget.id)
      if (flyCity?.id === deleteTarget.id) setFlyCity(null)
      if (hoveredCityId === deleteTarget.id) setHoveredCityId(null)
      const next = await listCitiesAsync()
      setCities(next)
      setDeleteTarget(null)
      setDeleteCityError(null)
    } catch (err) {
      setDeleteCityError(err instanceof Error ? err.message : '删除地点失败')
    }
  }, [deleteTarget, flyCity?.id, hoveredCityId])

  const openMusicPicker = useCallback(() => {
    setMusicError(null)
    musicInputRef.current?.click()
  }, [])

  const onMusicFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (!f.type.startsWith('audio/')) {
      setMusicError('请选择音频文件（mp3/wav/m4a 等）')
      return
    }
    setMusicError(null)
    if (musicUrlRef.current) {
      URL.revokeObjectURL(musicUrlRef.current)
      musicUrlRef.current = null
    }
    const url = URL.createObjectURL(f)
    musicUrlRef.current = url
    setMusicUrl(url)
    setMusicName(f.name)
    setMusicCurrent(0)
    setMusicDuration(0)
    if (audioRef.current) {
      audioRef.current.src = url
      void audioRef.current.play().catch(() => {
        setMusicError('浏览器阻止了自动播放，请点击播放按钮')
      })
    }
  }, [])

  const loadNeteaseTrack = useCallback(() => {
    const songId = extractNeteaseSongId(musicLinkInput)
    if (!songId) {
      setMusicError('无法识别网易云歌曲链接，请确认包含 song?id=...')
      return
    }
    setMusicError(null)
    if (musicUrlRef.current) {
      URL.revokeObjectURL(musicUrlRef.current)
      musicUrlRef.current = null
    }
    const url = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`
    setMusicUrl(url)
    setMusicName(`NetEase #${songId}`)
    setMusicCurrent(0)
    setMusicDuration(0)
    if (audioRef.current) {
      audioRef.current.src = url
      void audioRef.current.play().catch(() => {
        setMusicError('该链接可能受版权限制，无法直接播放')
      })
    }
  }, [musicLinkInput])

  const toggleMusicPlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !musicUrl) return
    setMusicError(null)
    if (audio.paused) {
      void audio.play().catch(() => {
        setMusicError('播放失败，请重试')
      })
    } else {
      audio.pause()
    }
  }, [musicUrl])

  const onMusicSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const nextTime = Number(e.target.value)
    if (!Number.isFinite(nextTime)) return
    audio.currentTime = nextTime
    setMusicCurrent(nextTime)
  }, [])

  const onMusicVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(e.target.value)
    if (!Number.isFinite(nextVolume)) return
    setMusicVolume(nextVolume)
  }, [])

  const toggleMusicLoop = useCallback(() => {
    setMusicLoop((v) => !v)
  }, [])

  const handleFlightTweenComplete = useCallback(
    (cityId: string) => {
      const o = { v: 0 }
      gsap.to(o, {
        v: 1,
        duration: 0.45,
        ease: 'power3.inOut',
        onUpdate: () => setVignetteOpacity(o.v),
        onComplete: () => navigate(`/album/${cityId}`),
      })
    },
    [navigate],
  )

  return (
    <main className="scene-wrap">
      <div className="hud">
        <h1>Retro Voyage Atlas</h1>
        <p>照片是时间写的注脚 — 点击城市进入相册。</p>
        <div className="hud-actions">
          <button
            type="button"
            className="hud-barista-btn hud-city-btn"
            onClick={() => {
              setCreateCityError(null)
              setShowCreateCity((v) => !v)
            }}
          >
            New Place
          </button>
        </div>
        {showCreateCity && (
          <div className="hud-city-form">
            <input
              value={newCityName}
              onChange={(e) => setNewCityName(e.target.value)}
              placeholder="地点名（如 Chengdu）"
            />
            <div className="hud-city-row">
              <input
                value={newCityLat}
                onChange={(e) => setNewCityLat(e.target.value)}
                placeholder="纬度 lat"
              />
              <input
                value={newCityLon}
                onChange={(e) => setNewCityLon(e.target.value)}
                placeholder="经度 lon"
              />
            </div>
            <div className="hud-city-row">
              <button type="button" className="hud-city-action" onClick={resolveCoordinates} disabled={geocodeLoading}>
                {geocodeLoading ? '解析中…' : '解析坐标'}
              </button>
              <button type="button" className="hud-city-action" onClick={saveCity}>
                加入地球
              </button>
            </div>
            {createCityError && <p className="hud-city-error">{createCityError}</p>}
          </div>
        )}
      </div>

      <aside className="city-list-panel" aria-label="Added cities">
        <div className="city-list-title">Added Cities</div>
        <div className="city-list-items">
          {cities.map((city) => {
            const nameParts = splitCityLabel(city.name)
            const active = flyCity?.id === city.id
            const removable = !defaultCityIdSet.has(city.id)
            return (
              <div key={city.id} className={`city-list-row ${active ? 'city-list-row--active' : ''}`}>
                <button
                  type="button"
                  className={`city-list-item ${active ? 'city-list-item--active' : ''}`}
                  onClick={() => handleCityClick(city)}
                  onMouseEnter={() => setHoveredCityId(city.id)}
                  onMouseLeave={() => setHoveredCityId(null)}
                >
                  <span className="city-list-item-name">{nameParts.primary}</span>
                  <span className="city-list-item-coords">
                    {city.lat.toFixed(2)}, {city.lon.toFixed(2)}
                  </span>
                </button>
                {removable && (
                  <button
                    type="button"
                    className="city-list-delete"
                    onClick={() => requestDeleteCity(city)}
                    aria-label={`Delete ${nameParts.primary}`}
                    title="删除地点"
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      <section className="music-panel" aria-label="Music player">
        <input
          ref={musicInputRef}
          type="file"
          accept="audio/*"
          className="music-file-input"
          onChange={onMusicFileChange}
        />
        <audio ref={audioRef} preload="metadata" />
        <p className="music-panel-title">Music Deck</p>
        <p className="music-track-name" title={musicName}>
          {musicName}
        </p>
        <div className="music-link-row">
          <input
            value={musicLinkInput}
            onChange={(e) => setMusicLinkInput(e.target.value)}
            placeholder="Paste NetEase song link / id"
            className="music-link-input"
          />
          <button type="button" className="music-btn music-btn--load" onClick={loadNeteaseTrack}>
            Load
          </button>
        </div>
        <div className="music-actions">
          <button type="button" className="music-btn" onClick={openMusicPicker}>
            Upload
          </button>
          <button
            type="button"
            className="music-btn"
            onClick={toggleMusicPlayback}
            disabled={!musicUrl}
          >
            {musicPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className={`music-btn ${musicLoop ? 'music-btn--on' : ''}`}
            onClick={toggleMusicLoop}
            disabled={!musicUrl}
          >
            Loop
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(1, musicDuration)}
          value={Math.min(musicCurrent, Math.max(1, musicDuration))}
          className="music-progress"
          onChange={onMusicSeek}
          disabled={!musicUrl}
        />
        <div className="music-volume-row">
          <span className="music-volume-label">Vol</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={musicVolume}
            className="music-volume"
            onChange={onMusicVolumeChange}
          />
        </div>
        <div className="music-time">
          <span>{formatTime(musicCurrent)}</span>
          <span>{formatTime(musicDuration)}</span>
        </div>
        {musicError && <p className="music-error">{musicError}</p>}
      </section>

      {deleteTarget && (
        <div className="city-delete-dialog-backdrop" role="presentation" onClick={() => setDeleteTarget(null)}>
          <div
            className="city-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认删除地点"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="city-delete-title">确认删除此地点？</p>
            <p className="city-delete-name">{splitCityLabel(deleteTarget.name).primary}</p>
            <p className="city-delete-note">删除后会从地球与右侧列表移除，此操作不可撤销。</p>
            {deleteCityError && <p className="city-delete-error">{deleteCityError}</p>}
            <div className="city-delete-actions">
              <button type="button" className="city-delete-btn city-delete-btn--cancel" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button type="button" className="city-delete-btn city-delete-btn--danger" onClick={confirmDeleteCity}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="vignette-overlay"
        style={{ opacity: vignetteOpacity }}
        aria-hidden
      />

      <Canvas camera={{ position: [0, 0.2, 3.1], fov: 44 }}>
        <ambientLight intensity={0.18} color="#7486aa" />
        <hemisphereLight intensity={0.3} color="#8db7ed" groundColor="#140f1c" />
        <CameraBoundSunLight />
        <pointLight position={[3.6, 2.6, 2.6]} intensity={14} color="#ffc996" />
        <GalaxyBackground />
        <Globe
          flashRef={flashRef}
          earthGroupRef={earthGroupRef}
          spinPausedRef={spinPausedRef}
          cities={cities}
          hoveredCityId={hoveredCityId}
          onHoverCity={setHoveredCityId}
          onCityClick={handleCityClick}
        />
        <WeatherDirector flashRef={flashRef} />
        <FlyToController
          flyCity={flyCity}
          earthGroupRef={earthGroupRef}
          controlsRef={controlsRef}
          spinPausedRef={spinPausedRef}
          onFlightTweenComplete={handleFlightTweenComplete}
        />
        <OrbitControls
          ref={controlsRef}
          enableZoom
          enableDamping
          dampingFactor={0.08}
          zoomSpeed={0.6}
          minDistance={1.05}
          maxDistance={8}
          autoRotate={!flyCity}
          autoRotateSpeed={0.35}
          enabled={!flyCity}
        />
      </Canvas>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<GlobePage />} />
      <Route path="/album/:cityId" element={<Album />} />
    </Routes>
  )
}
