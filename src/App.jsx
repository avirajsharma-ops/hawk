import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import Peer from 'peerjs'
import {
  Camera,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  Mic,
  MicOff,
  Play,
  Square,
  RefreshCw,
  LogOut,
  Lock,
  Eye,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
  AlertTriangle,
  Volume2,
  ExternalLink,
  ShieldCheck,
  Loader2,
  Radio,
  ArrowLeft,
  Sliders,
  Disc,
  StopCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import './App.css'

// Well-known PeerJS IDs for the admin presence registry.
// First slot keeps the legacy id so older live broadcasters keep working.
const ADMIN_PEER_ID = 'hawk-admin-presence-mwhawk-v1'
const ADMIN_PEER_IDS = [
  ADMIN_PEER_ID,
  'hawk-admin-presence-mwhawk-v1-2',
  'hawk-admin-presence-mwhawk-v1-3',
  'hawk-admin-presence-mwhawk-v1-4',
]
const ADMIN_PIN = '2001'
const PRESENCE_HEARTBEAT_MS = 5000
const PRESENCE_TIMEOUT_MS = 15000
const ADMIN_RETRY_MS = 2500
const RESUME_STORAGE_KEY = 'hawk-resume-v1'

function readResumeSession() {
  try {
    const raw = localStorage.getItem(RESUME_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeResumeSession(session) {
  try {
    localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(session))
  } catch { /* noop */ }
}

function clearResumeSession() {
  try { localStorage.removeItem(RESUME_STORAGE_KEY) } catch { /* noop */ }
}

function generateRoomId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

const BUILTIN_HINTS = /(facetime|built[\s-]*in|integrated|internal|isight)/i
const USB_HINTS =
  /(usb|uvc|webcam|brio|logitech|elgato|anker|avermedia|microsoft\s*lifecam|razer|c920|c922|c270|c310|hd\s*pro|v4l|video\d+|\/dev\/video)/i

function classifyCamera(device, allDevices) {
  const searchable = [device.label, device.deviceId, device.groupId]
    .filter(Boolean)
    .join(' ')
  if (BUILTIN_HINTS.test(searchable)) return { isUsb: false, isBuiltIn: true }
  if (USB_HINTS.test(searchable)) return { isUsb: true, isBuiltIn: false }
  const videoCount = allDevices.filter((d) => d.kind === 'videoinput').length
  if (videoCount === 1 && device.label) return { isUsb: true, isBuiltIn: false }
  return { isUsb: false, isBuiltIn: false }
}

// Detect which way a camera faces from its label. Many Android browsers expose
// labels like "camera2 0, facing back" or "Back Camera"; iOS uses "Back" /
// "Front"; Samsung often uses "Rear" / "Front". Returns 'environment', 'user',
// or null when undetectable.
const FACING_BACK_RE = /\b(back|rear|environment|world|outward|exterior|trase|arri[eè]re|hinten|au[sß]en|zad|задн)/i
const FACING_FRONT_RE = /\b(front|user|self|selfie|face[\s-]?time|inward|interior|frontal|vorn|перед)/i
function detectFacing(label) {
  if (!label) return null
  if (FACING_BACK_RE.test(label)) return 'environment'
  if (FACING_FRONT_RE.test(label)) return 'user'
  return null
}

const IS_MOBILE_UA = /Android|iPhone|iPad|iPod/i

// Build the ordered list of MediaTrackConstraints attempts for a given camera
// entry. Crucially: when a facing direction is known/requested, we NEVER fall
// back to the opposite facing — otherwise selecting "Back camera" silently
// flips to the front camera on phones (e.g. Samsung tabs whose secondary back
// lens deviceIds can't actually open a stream).
function buildVideoAttempts(camera) {
  const attempts = []
  const facing = camera?.facing || null
  const ids = camera?.candidateIds && camera.candidateIds.length
    ? camera.candidateIds
    : camera?.deviceId ? [camera.deviceId] : []

  if (facing) {
    // `exact` will throw OverconstrainedError rather than picking the other
    // camera — exactly what we want here.
    attempts.push({
      facingMode: { exact: facing },
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
    })
    attempts.push({ facingMode: { exact: facing }, width: { ideal: 640 }, height: { ideal: 480 } })
    attempts.push({ facingMode: { exact: facing } })
  }

  for (const id of ids) {
    const base = facing ? { facingMode: { ideal: facing } } : {}
    attempts.push({
      ...base, deviceId: { exact: id },
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
    })
    attempts.push({
      ...base, deviceId: { exact: id },
      width: { ideal: 640 }, height: { ideal: 480 },
    })
    attempts.push({ ...base, deviceId: { exact: id } })
  }

  if (!facing) {
    attempts.push({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } })
    attempts.push({ width: { ideal: 640 }, height: { ideal: 480 } })
    attempts.push(true)
  }

  return attempts
}

async function acquireStream(camera) {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
  const facing = camera?.facing || null
  const videoAttempts = buildVideoAttempts(camera)

  let lastError = null
  for (const video of videoAttempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio })
      // Verify we actually got the requested facing. Some Android browsers
      // ignore deviceId constraints and hand back the default (front) camera.
      if (facing) {
        const track = stream.getVideoTracks()[0]
        const settings = track?.getSettings?.() || {}
        const got = settings.facingMode
        if (got && got !== facing) {
          stream.getTracks().forEach((t) => t.stop())
          continue
        }
      }
      return stream
    } catch (err) {
      lastError = err
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        break
      }
    }
  }

  // Audio sometimes blocks the open on Android Chrome; retry video-only,
  // still respecting the requested facing if one was specified.
  if (!lastError || (lastError.name !== 'NotAllowedError' && lastError.name !== 'SecurityError')) {
    const fallback = facing ? { facingMode: { ideal: facing } } : true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: fallback })
      if (facing) {
        const got = stream.getVideoTracks()[0]?.getSettings?.().facingMode
        if (got && got !== facing) {
          stream.getTracks().forEach((t) => t.stop())
          throw new Error(`Requested ${facing} camera but received ${got}`)
        }
      }
      return stream
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('Unable to access camera')
}

function tuneSenderBitrate(call) {
  const pc = call?.peerConnection
  if (!pc) return
  try {
    pc.getSenders().forEach((sender) => {
      if (sender.track?.kind !== 'video') return
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }
      params.encodings.forEach((enc) => {
        enc.maxBitrate = 2_500_000
        enc.maxFramerate = 30
        enc.priority = 'high'
        enc.networkPriority = 'high'
      })
      sender.setParameters(params).catch(() => {})
    })
  } catch { /* best-effort */ }
}

// Subset of MediaTrackCapabilities we expose to the admin UI.
const CONTROLLABLE_KEYS = [
  'zoom', 'focusDistance', 'exposureTime', 'exposureCompensation',
  'brightness', 'contrast', 'saturation', 'sharpness',
  'colorTemperature', 'whiteBalanceMode', 'focusMode', 'exposureMode', 'torch',
]

function snapshotCameraCapabilities(track, software) {
  const hw = {}
  if (track && typeof track.getCapabilities === 'function') {
    let caps = {}
    let settings = {}
    try { caps = track.getCapabilities() || {} } catch { caps = {} }
    try { settings = track.getSettings() || {} } catch { settings = {} }
    CONTROLLABLE_KEYS.forEach((key) => {
      if (key in caps) hw[key] = { capability: caps[key], current: settings[key] }
    })
  }
  return {
    hardware: Object.keys(hw).length ? hw : null,
    software: software || { ...DEFAULT_SOFTWARE_SETTINGS },
  }
}

const DEFAULT_SOFTWARE_SETTINGS = Object.freeze({
  brightness: 1, contrast: 1, saturate: 1, exposure: 1, zoom: 1,
})

const SOFTWARE_RANGES = Object.freeze({
  brightness: { min: 0.3, max: 2, step: 0.05, label: 'Brightness' },
  contrast:   { min: 0.3, max: 2, step: 0.05, label: 'Contrast' },
  saturate:   { min: 0,   max: 2, step: 0.05, label: 'Saturation' },
  exposure:   { min: 0.3, max: 2.5, step: 0.05, label: 'Exposure' },
  zoom:       { min: 1,   max: 4, step: 0.1,  label: 'Digital zoom' },
})

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/* -------------------------------------------------------------------------- */
/* Broadcaster                                                                */
/* -------------------------------------------------------------------------- */

function BroadcasterPage() {
  const previewRef = useRef(null)
  const adminAudioRef = useRef(null)
  const peerRef = useRef(null)
  const streamRef = useRef(null)
  const previewStreamRef = useRef(null)
  const camerasRef = useRef([])
  const rawVideoTrackRef = useRef(null)
  const softwareSettingsRef = useRef({ ...DEFAULT_SOFTWARE_SETTINGS })
  const swProcRef = useRef(null)
  const wakeLockRef = useRef(null)
  const statusRef = useRef('idle')
  const activeCallsRef = useRef(new Set())
  const viewerConnsRef = useRef(new Set())
  // Map<slotId, { conn, heartbeat }>
  const adminSlotsRef = useRef(new Map())
  const adminRetryRef = useRef(null)
  const connectAdminPresenceRef = useRef(() => {})
  const startBroadcastRef = useRef(() => {})
  const presenceStateRef = useRef({ roomId: '', title: '', startedAt: 0 })
  const autoResumeAttemptedRef = useRef(false)
  const [status, setStatus] = useState('idle')
  const [roomId, setRoomId] = useState('')
  const [error, setError] = useState('')
  const [cameras, setCameras] = useState([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [resolution, setResolution] = useState('')
  const [viewerCount, setViewerCount] = useState(0)
  const [copied, setCopied] = useState(false)
  const [streamTitle, setStreamTitle] = useState('')
  const [adminTalking, setAdminTalking] = useState(false)
  const [viewerTalking, setViewerTalking] = useState(false)
  const [hasPreview, setHasPreview] = useState(false)

  useEffect(() => { statusRef.current = status }, [status])

  const shareUrl = useMemo(() => {
    if (!roomId) return ''
    return `${window.location.origin}/watch/${roomId}`
  }, [roomId])

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    const videoInputs = devices.filter((d) => d.kind === 'videoinput')
    const isMobile = IS_MOBILE_UA.test(navigator.userAgent || '')

    let entries
    if (isMobile) {
      // Android/iOS commonly enumerate every physical lens (main / wide /
      // ultrawide / macro / telephoto) as a separate device — but on many
      // phones (e.g. Samsung S10 Lite Tab) only the default lens per facing
      // can actually stream. Collapse them into one logical option per
      // facing direction so the user picks "Back" vs "Front", and we keep
      // every underlying deviceId as a fallback candidate.
      const buckets = { environment: [], user: [], unknown: [] }
      videoInputs.forEach((d) => {
        const f = detectFacing(d.label)
        if (f) buckets[f].push(d)
        else buckets.unknown.push(d)
      })
      const labelsKnown = buckets.environment.length > 0 || buckets.user.length > 0

      if (!labelsKnown) {
        // No permission yet → no labels → can't group safely. Show one
        // generic entry so the user can grant permission; refreshCameras
        // will run again afterwards and group properly.
        entries = videoInputs.map((d, index) => ({
          deviceId: d.deviceId,
          candidateIds: [d.deviceId],
          label: d.label || (videoInputs.length === 1 ? 'Camera' : `Camera ${index + 1}`),
          facing: null,
          isUsb: false, isBuiltIn: true,
        }))
      } else {
        entries = []
        if (buckets.environment.length) {
          entries.push({
            deviceId: buckets.environment[0].deviceId,
            candidateIds: buckets.environment.map((d) => d.deviceId),
            label: 'Back camera',
            facing: 'environment',
            isUsb: false, isBuiltIn: true,
          })
        }
        if (buckets.user.length) {
          entries.push({
            deviceId: buckets.user[0].deviceId,
            candidateIds: buckets.user.map((d) => d.deviceId),
            label: 'Front camera',
            facing: 'user',
            isUsb: false, isBuiltIn: true,
          })
        }
        buckets.unknown.forEach((d, i) => {
          entries.push({
            deviceId: d.deviceId,
            candidateIds: [d.deviceId],
            label: d.label || `Camera ${entries.length + 1 + i}`,
            facing: null,
            isUsb: false, isBuiltIn: true,
          })
        })
      }
    } else {
      entries = videoInputs.map((d, index) => {
        const { isUsb, isBuiltIn } = classifyCamera(d, devices)
        return {
          deviceId: d.deviceId,
          candidateIds: [d.deviceId],
          label: d.label || `Camera ${index + 1}`,
          facing: detectFacing(d.label),
          isUsb, isBuiltIn,
        }
      })
    }

    camerasRef.current = entries
    setCameras(entries)
    setSelectedCameraId((current) => {
      if (current) {
        const match = entries.find(
          (c) => c.deviceId === current || c.candidateIds.includes(current)
        )
        if (match) return match.deviceId
      }
      if (isMobile) {
        const back = entries.find((c) => c.facing === 'environment')
        if (back) return back.deviceId
      }
      const usb = entries.find((c) => c.isUsb)
      return usb?.deviceId || entries[0]?.deviceId || ''
    })
  }, [])

  const unlockLabels = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      probe.getTracks().forEach((t) => t.stop())
    } catch { /* noop */ }
    await refreshCameras()
  }, [refreshCameras])

  const stopPreviewStream = useCallback(() => {
    const s = previewStreamRef.current
    if (!s) return
    s.getTracks().forEach((t) => t.stop())
    previewStreamRef.current = null
    if (previewRef.current && !streamRef.current) previewRef.current.srcObject = null
    setHasPreview(false)
  }, [])

  const resolveCameraEntry = useCallback((id) => {
    const list = camerasRef.current || []
    if (!id) return list[0] || null
    return (
      list.find((c) => c.deviceId === id || c.candidateIds?.includes(id)) ||
      list[0] || null
    )
  }, [])

  const acquirePreview = useCallback(async (deviceId) => {
    // Don't disturb a live broadcast — it owns the camera while live.
    if (statusRef.current === 'live' || statusRef.current === 'starting') return
    try {
      const targetId = deviceId || selectedCameraId
      const camera = resolveCameraEntry(targetId)
      const existing = previewStreamRef.current
      if (existing) {
        const track = existing.getVideoTracks()[0]
        const currentId = track?.getSettings?.().deviceId
        const currentMatches = camera
          ? (camera.deviceId === currentId || camera.candidateIds?.includes(currentId))
          : (!targetId || currentId === targetId)
        if (track && currentMatches) {
          if (previewRef.current && previewRef.current.srcObject !== existing) {
            previewRef.current.srcObject = existing
          }
          setHasPreview(true)
          return
        }
        stopPreviewStream()
      }

      // Reuse the same constraint ladder as live capture so behavior is
      // identical for preview vs broadcast (including no opposite-facing
      // fallback).
      const videoAttempts = buildVideoAttempts(camera || (targetId ? { candidateIds: [targetId] } : null))
      const facing = camera?.facing || null
      let next = null
      let lastErr = null
      for (const v of videoAttempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false })
          if (facing) {
            const got = stream.getVideoTracks()[0]?.getSettings?.().facingMode
            if (got && got !== facing) {
              stream.getTracks().forEach((t) => t.stop())
              continue
            }
          }
          next = stream
          break
        } catch (err) {
          lastErr = err
          if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break
        }
      }
      if (!next) throw lastErr || new Error('Unable to access camera')
      // Race-safe: if we went live during await, drop this stream.
      if (statusRef.current === 'live' || statusRef.current === 'starting') {
        next.getTracks().forEach((t) => t.stop())
        return
      }
      previewStreamRef.current = next
      if (previewRef.current) previewRef.current.srcObject = next
      setHasPreview(true)
      const track = next.getVideoTracks()[0]
      if (track?.getSettings) {
        const s = track.getSettings()
        // Keep selection sticky to the grouped entry's representative id so
        // the <select> stays aligned with what is actually playing.
        if (camera) setSelectedCameraId(camera.deviceId)
        else if (s.deviceId) setSelectedCameraId(s.deviceId)
      }
      // Refresh labels in case this was the first permission grant.
      await refreshCameras()
    } catch (err) {
      setHasPreview(false)
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        setError('Camera permission was denied. Tap "Enable camera" to retry.')
      } else if (err && err.name === 'OverconstrainedError') {
        setError('Selected camera could not be opened. Try the other camera or tap refresh.')
      }
    }
  }, [selectedCameraId, refreshCameras, stopPreviewStream, resolveCameraEntry])

  const releaseWakeLock = useCallback(async () => {
    if (!wakeLockRef.current) return
    await wakeLockRef.current.release().catch(() => {})
    wakeLockRef.current = null
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator) || wakeLockRef.current) return
    try {
      const wakeLock = await navigator.wakeLock.request('screen')
      wakeLockRef.current = wakeLock
      wakeLock.addEventListener('release', () => { wakeLockRef.current = null })
    } catch { /* noop */ }
  }, [])

  const swSettingsAreDefault = useCallback((s) => {
    return ['brightness','contrast','saturate','exposure','zoom'].every((k) => Math.abs((s[k] ?? 1) - DEFAULT_SOFTWARE_SETTINGS[k]) < 0.001)
  }, [])

  const teardownSoftwareProcessor = useCallback(() => {
    const proc = swProcRef.current
    if (!proc) return
    if (proc.rafId) cancelAnimationFrame(proc.rafId)
    if (proc.video) { try { proc.video.pause() } catch { /* noop */ } proc.video.srcObject = null }
    try { proc.outStream?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
    swProcRef.current = null
  }, [])

  const buildSoftwareProcessor = useCallback(() => {
    const raw = rawVideoTrackRef.current
    if (!raw) return null
    const settings = raw.getSettings?.() || {}
    const w = settings.width || 1280
    const h = settings.height || 720
    const srcStream = new MediaStream([raw])
    const video = document.createElement('video')
    video.srcObject = srcStream
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    video.play().catch(() => {})
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const outStream = canvas.captureStream(30)
    const outTrack = outStream.getVideoTracks()[0]
    const proc = { video, canvas, ctx, outStream, outTrack, rafId: 0 }
    const draw = () => {
      const s = softwareSettingsRef.current
      try {
        if (video.readyState >= 2) {
          const brightness = (s.brightness ?? 1) * (s.exposure ?? 1)
          const contrast = s.contrast ?? 1
          const saturate = s.saturate ?? 1
          ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`
          const z = Math.max(1, s.zoom ?? 1)
          const sw = canvas.width / z
          const sh = canvas.height / z
          const sx = (canvas.width - sw) / 2
          const sy = (canvas.height - sh) / 2
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
        }
      } catch { /* noop */ }
      proc.rafId = requestAnimationFrame(draw)
    }
    proc.rafId = requestAnimationFrame(draw)
    return proc
  }, [])

  const replaceVideoTrackOnCalls = useCallback((track) => {
    activeCallsRef.current.forEach((call) => {
      const pc = call?.peerConnection
      if (!pc) return
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'video') {
          try { sender.replaceTrack(track) } catch { /* noop */ }
        }
      })
    })
    // Keep streamRef video track in sync so future calls publish the same track
    const stream = streamRef.current
    if (stream && track) {
      const existing = stream.getVideoTracks()[0]
      if (existing && existing !== track) {
        try { stream.removeTrack(existing) } catch { /* noop */ }
      }
      if (!stream.getVideoTracks().includes(track)) {
        try { stream.addTrack(track) } catch { /* noop */ }
      }
    }
  }, [])

  const applySoftwareSettings = useCallback((next) => {
    softwareSettingsRef.current = { ...softwareSettingsRef.current, ...next }
    const s = softwareSettingsRef.current
    if (swSettingsAreDefault(s)) {
      // Restore raw track
      if (swProcRef.current) {
        const raw = rawVideoTrackRef.current
        teardownSoftwareProcessor()
        if (raw) replaceVideoTrackOnCalls(raw)
      }
      return
    }
    if (!swProcRef.current) {
      const proc = buildSoftwareProcessor()
      if (!proc) return
      swProcRef.current = proc
      replaceVideoTrackOnCalls(proc.outTrack)
    }
  }, [swSettingsAreDefault, teardownSoftwareProcessor, buildSoftwareProcessor, replaceVideoTrackOnCalls])

  const sendPresence = useCallback(() => {
    adminSlotsRef.current.forEach(({ conn }) => {
      if (!conn || !conn.open) return
      try {
        conn.send({
          type: 'presence',
          roomId: presenceStateRef.current.roomId,
          title: presenceStateRef.current.title,
          startedAt: presenceStateRef.current.startedAt,
          viewerCount: activeCallsRef.current.size,
        })
      } catch { /* noop */ }
    })
  }, [])

  const closeAdminSlot = useCallback((slotId) => {
    const slot = adminSlotsRef.current.get(slotId)
    if (!slot) return
    if (slot.heartbeat) clearInterval(slot.heartbeat)
    if (slot.conn) { try { slot.conn.close() } catch { /* noop */ } }
    adminSlotsRef.current.delete(slotId)
  }, [])

  const closeAdminPresence = useCallback(() => {
    Array.from(adminSlotsRef.current.keys()).forEach((slotId) => {
      const slot = adminSlotsRef.current.get(slotId)
      if (slot?.heartbeat) clearInterval(slot.heartbeat)
      if (slot?.conn) { try { slot.conn.close() } catch { /* noop */ } }
    })
    adminSlotsRef.current.clear()
  }, [])

  const connectAdminPresence = useCallback(() => {
    if (adminRetryRef.current) {
      clearTimeout(adminRetryRef.current)
      adminRetryRef.current = null
    }
    const peer = peerRef.current
    const retryLater = () => {
      adminRetryRef.current = setTimeout(
        () => connectAdminPresenceRef.current(),
        ADMIN_RETRY_MS
      )
    }
    if (!peer || peer.destroyed || peer.disconnected) {
      retryLater()
      return
    }

    ADMIN_PEER_IDS.forEach((slotId) => {
      if (adminSlotsRef.current.has(slotId)) {
        const existing = adminSlotsRef.current.get(slotId)
        if (existing?.conn?.open) return
        closeAdminSlot(slotId)
      }

      let conn
      try {
        conn = peer.connect(slotId, { reliable: true, serialization: 'json' })
      } catch {
        return
      }
      const slot = { conn, heartbeat: null, openTimer: null }
      adminSlotsRef.current.set(slotId, slot)

      // If the admin slot isn't claimed, PeerJS fires `peer-unavailable` on the
      // peer (not the conn), so this conn would silently never open. Force a
      // cleanup after 4s so the retry loop will try again.
      slot.openTimer = setTimeout(() => {
        if (!conn.open) {
          try { conn.close() } catch { /* noop */ }
          cleanup()
        }
      }, 4000)

      const cleanup = () => {
        if (slot.heartbeat) { clearInterval(slot.heartbeat); slot.heartbeat = null }
        if (slot.openTimer) { clearTimeout(slot.openTimer); slot.openTimer = null }
        if (adminSlotsRef.current.get(slotId) === slot) {
          adminSlotsRef.current.delete(slotId)
        }
        if (statusRef.current === 'live' || statusRef.current === 'starting') {
          if (!adminRetryRef.current) {
            adminRetryRef.current = setTimeout(
              () => connectAdminPresenceRef.current(),
              ADMIN_RETRY_MS
            )
          }
        }
      }

      conn.on('open', () => {
        if (slot.openTimer) { clearTimeout(slot.openTimer); slot.openTimer = null }
        try {
          conn.send({
            type: 'presence',
            roomId: presenceStateRef.current.roomId,
            title: presenceStateRef.current.title,
            startedAt: presenceStateRef.current.startedAt,
            viewerCount: activeCallsRef.current.size,
          })
        } catch { /* noop */ }
        slot.heartbeat = setInterval(() => {
          if (!conn.open) return
          try {
            conn.send({
              type: 'presence',
              roomId: presenceStateRef.current.roomId,
              title: presenceStateRef.current.title,
              startedAt: presenceStateRef.current.startedAt,
              viewerCount: activeCallsRef.current.size,
            })
          } catch { /* noop */ }
        }, PRESENCE_HEARTBEAT_MS)
      })
      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return
        if (data.type === 'admin-refresh') {
          const session = presenceStateRef.current
          if (session.roomId) {
            writeResumeSession({
              roomId: session.roomId,
              title: session.title,
              cameraId: selectedCameraId,
              savedAt: Date.now(),
            })
          }
          setTimeout(() => window.location.reload(), 200)
        }
      })
      conn.on('close', cleanup)
      conn.on('error', cleanup)
    })
  }, [closeAdminSlot, selectedCameraId])

  useEffect(() => {
    connectAdminPresenceRef.current = connectAdminPresence
  }, [connectAdminPresence])

  const startBroadcast = useCallback(async (override = {}) => {
    if (statusRef.current === 'starting' || statusRef.current === 'live') return
    setError('')
    setStatus('starting')

    const desiredRoomId = override.roomId || generateRoomId()
    const desiredTitle = override.title !== undefined ? override.title : streamTitle.trim()
    const desiredCameraId = override.cameraId || selectedCameraId

    // Release preview-only stream so live capture can claim the camera.
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach((t) => t.stop())
      previewStreamRef.current = null
      setHasPreview(false)
    }

    try {
      const cameraEntry = resolveCameraEntry(desiredCameraId)
      const localStream = await acquireStream(cameraEntry)
      streamRef.current = localStream
      rawVideoTrackRef.current = localStream.getVideoTracks()[0] || null
      // Reset software pipeline to defaults on fresh capture
      softwareSettingsRef.current = { ...DEFAULT_SOFTWARE_SETTINGS }
      if (swProcRef.current) { teardownSoftwareProcessor() }
      await refreshCameras()

      const videoTrack = localStream.getVideoTracks()[0]
      const settings = videoTrack?.getSettings() || {}
      if (settings.deviceId) setSelectedCameraId(settings.deviceId)
      if (settings.width && settings.height) {
        const fps = Math.round(settings.frameRate || 0)
        setResolution(`${settings.width}×${settings.height}${fps ? ` @ ${fps}fps` : ''}`)
      }
      if (previewRef.current) previewRef.current.srcObject = localStream

      presenceStateRef.current = {
        roomId: desiredRoomId,
        title: desiredTitle,
        startedAt: Date.now(),
      }
      if (desiredTitle !== streamTitle) setStreamTitle(desiredTitle)

      writeResumeSession({
        roomId: desiredRoomId,
        title: desiredTitle,
        cameraId: settings.deviceId || desiredCameraId,
        savedAt: Date.now(),
      })

      const createPeer = (attempt = 0) => {
        const peer = new Peer(desiredRoomId, { debug: 0 })
        peerRef.current = peer

        peer.on('open', () => {
          setRoomId(desiredRoomId)
          setStatus('live')
          requestWakeLock()
          connectAdminPresence()
        })

        peer.on('connection', (conn) => {
          const isAdminWatch = conn.metadata?.kind === 'admin-watch'
          viewerConnsRef.current.add(conn)
          const dropConn = () => viewerConnsRef.current.delete(conn)
          conn.on('close', dropConn)
          conn.on('error', dropConn)
          conn.on('data', (data) => {
            if (!data || typeof data !== 'object') return
            if (data.type === 'admin-refresh') {
              const session = presenceStateRef.current
              if (session.roomId) {
                writeResumeSession({
                  roomId: session.roomId,
                  title: session.title,
                  cameraId: selectedCameraId,
                  savedAt: Date.now(),
                })
              }
              setTimeout(() => window.location.reload(), 200)
            } else if (data.type === 'camera-control' && data.pin === ADMIN_PIN) {
              const track = rawVideoTrackRef.current || streamRef.current?.getVideoTracks?.()[0]
              if (!track || typeof track.applyConstraints !== 'function') return
              const constraints = data.constraints && typeof data.constraints === 'object'
                ? { advanced: [data.constraints] }
                : null
              if (!constraints) return
              track.applyConstraints(constraints).then(() => {
                const snap = snapshotCameraCapabilities(rawVideoTrackRef.current || track, softwareSettingsRef.current)
                if (conn.open) {
                  try { conn.send({ type: 'camera-capabilities', caps: snap }) } catch { /* noop */ }
                }
              }).catch((err) => {
                if (conn.open) {
                  try { conn.send({ type: 'camera-control-error', message: err?.message || 'apply failed' }) } catch { /* noop */ }
                }
              })
            } else if (data.type === 'software-control' && data.pin === ADMIN_PIN) {
              if (data.settings && typeof data.settings === 'object') {
                applySoftwareSettings(data.settings)
                const snap = snapshotCameraCapabilities(rawVideoTrackRef.current, softwareSettingsRef.current)
                if (conn.open) {
                  try { conn.send({ type: 'camera-capabilities', caps: snap }) } catch { /* noop */ }
                }
              }
            } else if (data.type === 'camera-capabilities-request' && data.pin === ADMIN_PIN) {
              const snap = snapshotCameraCapabilities(rawVideoTrackRef.current, softwareSettingsRef.current)
              if (conn.open) {
                try { conn.send({ type: 'camera-capabilities', caps: snap }) } catch { /* noop */ }
              }
            }
          })

          conn.on('open', () => {
            if (isAdminWatch) {
              const snap = snapshotCameraCapabilities(rawVideoTrackRef.current, softwareSettingsRef.current)
              try { conn.send({ type: 'camera-capabilities', caps: snap }) } catch { /* noop */ }
            }
            const call = peer.call(conn.peer, streamRef.current || localStream)
            if (!call) return
            activeCallsRef.current.add(call)
            if (!isAdminWatch) {
              setViewerCount(activeCallsRef.current.size)
              sendPresence()
            }

            const tune = () => tuneSenderBitrate(call)
            if (call.peerConnection) {
              const pc = call.peerConnection
              pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'connected') tune()
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                  try { pc.restartIce?.() } catch { /* noop */ }
                }
              })
              pc.addEventListener('iceconnectionstatechange', () => {
                if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                  try { pc.restartIce?.() } catch { /* noop */ }
                }
              })
              setTimeout(tune, 1500)
            }

            const dropCall = () => {
              activeCallsRef.current.delete(call)
              if (!isAdminWatch) {
                setViewerCount(activeCallsRef.current.size)
                sendPresence()
              }
            }
            call.on('close', dropCall)
            call.on('error', dropCall)
          })
        })

        // Inbound audio-only calls: admin or viewer push-to-talk.
        peer.on('call', (incomingCall) => {
          const kind = incomingCall.metadata?.kind
          if (kind !== 'admin-ptt' && kind !== 'viewer-ptt') {
            try { incomingCall.close() } catch { /* noop */ }
            return
          }
          incomingCall.answer()
          incomingCall.on('stream', (remoteStream) => {
            const el = adminAudioRef.current
            if (!el) return
            el.srcObject = remoteStream
            el.muted = false
            el.play().catch(() => {})
            if (kind === 'admin-ptt') setAdminTalking(true)
            else setViewerTalking(true)
          })
          const stop = () => {
            const el = adminAudioRef.current
            if (el) el.srcObject = null
            if (kind === 'admin-ptt') setAdminTalking(false)
            else setViewerTalking(false)
          }
          incomingCall.on('close', stop)
          incomingCall.on('error', stop)
        })

        peer.on('disconnected', () => {
          try { peer.reconnect() } catch { /* noop */ }
        })

        peer.on('error', (peerError) => {
          if (peerError?.type === 'unavailable-id' && attempt < 20) {
            // Broker is still holding the prior peer id (common right after
            // a reload). Retry for up to ~40s before giving up.
            try { peer.destroy() } catch { /* noop */ }
            setTimeout(() => createPeer(attempt + 1), 2000)
            return
          }
          if (peerError?.type === 'unavailable-id') {
            setError('Room ID is busy. Try again in a few seconds or pick a new one.')
            setStatus('idle')
            clearResumeSession()
            return
          }
          const nonFatal = new Set([
            'peer-unavailable', 'network', 'server-error',
            'disconnected', 'socket-error', 'socket-closed',
          ])
          if (nonFatal.has(peerError?.type)) {
            if (peerError?.type === 'peer-unavailable') {
              // A pending admin-slot or PTT conn target is unclaimed.
              // Don't tear down healthy slots — the per-slot open-timer will
              // clean up any pending conns and the retry loop will try again.
              if (!adminRetryRef.current) {
                adminRetryRef.current = setTimeout(
                  () => connectAdminPresenceRef.current(),
                  ADMIN_RETRY_MS
                )
              }
            } else {
              setError(`${peerError.message || 'Signaling issue'} — retrying...`)
            }
            return
          }
          setError(peerError?.message || 'Failed to start broadcast')
          setStatus('idle')
        })
      }

      createPeer()
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
        setError('Camera permission was denied. Tap the camera icon in the address bar to allow, then try again.')
      } else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        // Stale saved cameraId after Android reload: forget it so the next
        // attempt uses facingMode and succeeds.
        clearResumeSession()
        setError('Couldn\u2019t start the saved camera. Tap Go Live again to pick a working one.')
      } else if (err?.name === 'NotReadableError') {
        setError('Camera is in use by another app. Close it and try again.')
      } else {
        setError(err?.message || 'Unable to access camera.')
      }
      setStatus('idle')
    }
  }, [
    streamTitle, selectedCameraId, refreshCameras, resolveCameraEntry,
    requestWakeLock, connectAdminPresence, closeAdminPresence, sendPresence,
  ])

  useEffect(() => { startBroadcastRef.current = startBroadcast }, [startBroadcast])

  const stopBroadcast = () => {
    viewerConnsRef.current.forEach((conn) => {
      if (conn.open) {
        try { conn.send({ type: 'bye', reason: 'broadcaster-stopped' }) } catch { /* noop */ }
      }
    })
    adminSlotsRef.current.forEach(({ conn }) => {
      if (conn?.open) {
        try {
          conn.send({ type: 'bye', roomId: presenceStateRef.current.roomId })
        } catch { /* noop */ }
      }
    })
    if (adminRetryRef.current) {
      clearTimeout(adminRetryRef.current)
      adminRetryRef.current = null
    }
    closeAdminPresence()
    setTimeout(() => {
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }
    }, 250)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (previewRef.current) previewRef.current.srcObject = null
    activeCallsRef.current.clear()
    viewerConnsRef.current.clear()
    presenceStateRef.current = { roomId: '', title: '', startedAt: 0 }
    clearResumeSession()
    setAdminTalking(false)
    setViewerTalking(false)
    setViewerCount(0)
    releaseWakeLock()
    setRoomId('')
    setResolution('')
    setStatus('idle')
    setError('')
    // Re-acquire low-cost preview after going offline.
    setTimeout(() => { void acquirePreview() }, 300)
  }

  const copyShareUrl = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* noop */ }
  }

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => { void refreshCameras() }, 0)
    // Try to start the live preview right away (will silently fail if no permission yet).
    const initialPreview = window.setTimeout(() => { void acquirePreview() }, 100)
    const resume = readResumeSession()
    if (resume && resume.roomId && !autoResumeAttemptedRef.current) {
      autoResumeAttemptedRef.current = true
      window.setTimeout(() => {
        startBroadcastRef.current({
          roomId: resume.roomId,
          title: resume.title || '',
          cameraId: resume.cameraId || '',
        })
      }, 600)
    }
    const onDeviceChange = () => { void refreshCameras() }
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && statusRef.current === 'live') {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // On reload/close, destroy the PeerJS connection cleanly so the broker
    // releases the room id immediately. Without this, the next page load
    // hits `unavailable-id` for ~30s and the broadcaster gets stuck on
    // "starting" — especially painful on Android where reload is common.
    const onPageHide = () => {
      try {
        viewerConnsRef.current.forEach((c) => {
          if (c.open) { try { c.send({ type: 'bye', reason: 'broadcaster-unload' }) } catch { /* noop */ } }
        })
        adminSlotsRef.current.forEach(({ conn }) => {
          if (conn?.open) { try { conn.send({ type: 'bye', roomId: presenceStateRef.current.roomId }) } catch { /* noop */ } }
        })
      } catch { /* noop */ }
      try { peerRef.current?.destroy() } catch { /* noop */ }
      peerRef.current = null
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onPageHide)

    return () => {
      clearTimeout(initialRefresh)
      clearTimeout(initialPreview)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
      if (adminRetryRef.current) {
        clearTimeout(adminRetryRef.current)
        adminRetryRef.current = null
      }
      closeAdminPresence()
      if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach((t) => t.stop())
        previewStreamRef.current = null
      }
      releaseWakeLock()
    }
  }, [refreshCameras, releaseWakeLock, requestWakeLock, closeAdminPresence, acquirePreview])

  // When camera selection changes, swap the preview or live track.
  useEffect(() => {
    if (statusRef.current === 'starting') return
    if (!selectedCameraId) return
    if (statusRef.current === 'live') {
      const currentLive = streamRef.current?.getVideoTracks?.()[0]?.getSettings?.().deviceId
      const cameraEntry = resolveCameraEntry(selectedCameraId)
      if (
        currentLive &&
        cameraEntry &&
        (cameraEntry.deviceId === currentLive || cameraEntry.candidateIds?.includes(currentLive))
      ) return
      ;(async () => {
        try {
          const newStream = await acquireStream(cameraEntry)
          const newTrack = newStream.getVideoTracks()[0]
          if (!newTrack) { newStream.getTracks().forEach((t) => t.stop()); return }
          // Discard newly acquired audio — keep the original mic.
          newStream.getAudioTracks().forEach((t) => t.stop())
          // Tear down software processor (if any) and stop the old raw track.
          teardownSoftwareProcessor()
          const oldRaw = rawVideoTrackRef.current
          rawVideoTrackRef.current = newTrack
          softwareSettingsRef.current = { ...DEFAULT_SOFTWARE_SETTINGS }
          replaceVideoTrackOnCalls(newTrack)
          if (previewRef.current) previewRef.current.srcObject = streamRef.current
          try { oldRaw && oldRaw.stop() } catch { /* noop */ }
          const settings = newTrack.getSettings() || {}
          if (settings.width && settings.height) {
            const fps = Math.round(settings.frameRate || 0)
            setResolution(`${settings.width}×${settings.height}${fps ? ` @ ${fps}fps` : ''}`)
          }
        } catch {
          setError('Could not switch to the selected camera.')
        }
      })()
      return
    }
    const current = previewStreamRef.current?.getVideoTracks?.()[0]?.getSettings?.().deviceId
    const cameraEntry = resolveCameraEntry(selectedCameraId)
    if (
      current &&
      cameraEntry &&
      (cameraEntry.deviceId === current || cameraEntry.candidateIds?.includes(current))
    ) return
    void acquirePreview(selectedCameraId)
  }, [selectedCameraId, acquirePreview, replaceVideoTrackOnCalls, teardownSoftwareProcessor, resolveCameraEntry])

  const isLive = status === 'live'
  const isStarting = status === 'starting'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Radio size={18} strokeWidth={2.2} />
          <span>HAWK</span>
        </div>
        <div className="topbar-status">
          {isLive ? (
            <span className="badge badge-live">
              <span className="dot" /> LIVE
            </span>
          ) : (
            <span className="badge badge-idle">
              <span className="dot dot-idle" /> OFFLINE
            </span>
          )}
          {isLive && (
            <>
              <span className="badge badge-soft">
                <Eye size={14} /> {viewerCount}
              </span>
              {resolution && (
                <span className="badge badge-soft">{resolution}</span>
              )}
            </>
          )}
        </div>
        <div className="topbar-actions">
          <Link to="/admin" className="iconLink" title="Admin dashboard">
            <ShieldCheck size={18} />
            <span>Admin</span>
          </Link>
        </div>
      </header>

      <main className="broadcaster">
        <section className="stagePane">
          <div className="stage">
            {!streamRef.current && !hasPreview && (
              <div className="stageEmpty">
                {isStarting ? (
                  <>
                    <Loader2 className="spin" size={42} />
                    <p>Starting camera…</p>
                  </>
                ) : (
                  <>
                    <VideoOff size={42} />
                    <p>Camera preview will appear here</p>
                    {cameras.length > 0 && (
                      <button type="button" className="btn" onClick={() => acquirePreview()}>
                        <Camera size={16} />
                        <span>Enable preview</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <video
              ref={previewRef}
              autoPlay playsInline muted
              className={`stageVideo ${isLive || isStarting || hasPreview ? 'visible' : ''}`}
            />
            <audio ref={adminAudioRef} autoPlay playsInline />

            {!isLive && !isStarting && hasPreview && (
              <div className="previewBadge">
                <Camera size={12} /> Preview
              </div>
            )}

            {(adminTalking || viewerTalking) && (
              <div className="talkBanner">
                <Volume2 size={16} />
                <span>{adminTalking ? 'Admin' : 'Viewer'} is talking to you</span>
              </div>
            )}
          </div>
        </section>

        <aside className="sidePane">
          <div className="panel">
            <h2 className="panelHeading">
              <Video size={16} /> Stream
            </h2>

            <label className="field">
              <span className="fieldLabel">Name (optional)</span>
              <input
                type="text"
                className="input"
                placeholder="Front door camera"
                value={streamTitle}
                onChange={(e) => setStreamTitle(e.target.value)}
                disabled={isLive || isStarting}
                maxLength={60}
              />
            </label>

            <label className="field">
              <span className="fieldLabel">Camera</span>
              <div className="row">
                <select
                  className="input"
                  value={selectedCameraId}
                  onChange={(e) => setSelectedCameraId(e.target.value)}
                  disabled={isLive || isStarting || cameras.length === 0}
                >
                  {cameras.length === 0 && <option value="">No camera detected</option>}
                  {cameras.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label}{c.isUsb ? ' — USB' : (c.isBuiltIn && !c.facing) ? ' — Built-in' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="iconBtn"
                  onClick={unlockLabels}
                  title="Detect cameras"
                  aria-label="Detect cameras"
                >
                  <RefreshCw size={16} />
                </button>
              </div>
              {cameras.length === 0 && (
                <p className="hint">On Raspberry Pi, plug in the USB webcam then refresh.</p>
              )}
            </label>

            <div className="actionRow">
              {!isLive ? (
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  onClick={() => startBroadcast()}
                  disabled={isStarting}
                >
                  {isStarting ? <Loader2 size={18} className="spin" /> : <Play size={18} />}
                  <span>{isStarting ? 'Starting' : 'Go Live'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger btn-block"
                  onClick={stopBroadcast}
                >
                  <Square size={16} />
                  <span>Stop Stream</span>
                </button>
              )}
            </div>

            {error && (
              <p className="alert">
                <AlertTriangle size={14} /> {error}
              </p>
            )}
          </div>

          {shareUrl && (
            <div className="panel">
              <h2 className="panelHeading">
                <ExternalLink size={16} /> Share
              </h2>
              <div className="shareLine">
                <a href={shareUrl} target="_blank" rel="noreferrer" className="shareUrl">
                  {shareUrl}
                </a>
                <button
                  type="button"
                  className="iconBtn"
                  onClick={copyShareUrl}
                  title={copied ? 'Copied' : 'Copy link'}
                  aria-label="Copy link"
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Viewer                                                                     */
/* -------------------------------------------------------------------------- */

function ViewerPage() {
  const { roomId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const isAdminMode = useMemo(() => {
    if (searchParams.get('admin') === '0') return false
    if (searchParams.get('admin') === '1') return true
    try { return sessionStorage.getItem('hawk-admin-unlocked') === '1' } catch { return false }
  }, [searchParams])
  const containerRef = useRef(null)
  const videoRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const streamTimerRef = useRef(null)
  const attemptRef = useRef(0)
  const peerRef = useRef(null)
  const connRef = useRef(null)
  const pttCallRef = useRef(null)
  const pttStreamRef = useRef(null)
  const recorderRef = useRef(null)
  const recorderChunksRef = useRef([])
  const timelapseRef = useRef(null)
  const [status, setStatus] = useState('connecting')
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pttSpeaking, setPttSpeaking] = useState(false)
  const [pttError, setPttError] = useState('')
  const [refreshSent, setRefreshSent] = useState(false)
  const [caps, setCaps] = useState(null)
  const [showControls, setShowControls] = useState(false)
  const [controlError, setControlError] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordError, setRecordError] = useState('')
  const [recordMode, setRecordMode] = useState('') // 'normal' | 'timelapse'
  const [showRecMenu, setShowRecMenu] = useState(false)

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    document.addEventListener('webkitfullscreenchange', onFs)
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      document.removeEventListener('webkitfullscreenchange', onFs)
    }
  }, [])

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        const el = containerRef.current || videoRef.current
        if (el?.requestFullscreen) await el.requestFullscreen()
        else if (videoRef.current?.webkitEnterFullscreen) videoRef.current.webkitEnterFullscreen()
      }
    } catch { /* noop */ }
  }

  const endPtt = useCallback(() => {
    if (pttStreamRef.current) {
      pttStreamRef.current.getTracks().forEach((t) => t.stop())
      pttStreamRef.current = null
    }
    if (pttCallRef.current) {
      try { pttCallRef.current.close() } catch { /* noop */ }
      pttCallRef.current = null
    }
    setPttSpeaking(false)
  }, [])

  const startPtt = useCallback(async () => {
    setPttError('')
    const peer = peerRef.current
    if (!peer || peer.destroyed) {
      setPttError('Not connected to the broadcaster yet.')
      return false
    }
    if (pttCallRef.current) return true

    let mic
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
        video: false,
      })
    } catch {
      setPttError('Microphone permission is required to talk.')
      return false
    }
    mic.getAudioTracks().forEach((t) => { t.enabled = false })
    const call = peer.call(roomId, mic, { metadata: { kind: 'viewer-ptt' } })
    if (!call) {
      mic.getTracks().forEach((t) => t.stop())
      setPttError('Could not open mic channel.')
      return false
    }
    pttStreamRef.current = mic
    pttCallRef.current = call
    const stop = () => {
      if (pttCallRef.current === call) endPtt()
    }
    call.on('close', stop)
    call.on('error', stop)
    return true
  }, [roomId, endPtt])

  const setTalking = useCallback((on) => {
    const s = pttStreamRef.current
    if (!s) return
    s.getAudioTracks().forEach((t) => { t.enabled = on })
    setPttSpeaking(on)
  }, [])

  const handlePttDown = useCallback(async () => {
    const ok = pttCallRef.current ? true : await startPtt()
    if (ok) setTalking(true)
  }, [startPtt, setTalking])

  const handlePttUp = useCallback(() => { setTalking(false) }, [setTalking])

  const handleAdminRefresh = useCallback(() => {
    const conn = connRef.current
    if (!conn || !conn.open) return
    try {
      conn.send({ type: 'admin-refresh', pin: ADMIN_PIN })
      setRefreshSent(true)
      setTimeout(() => setRefreshSent(false), 2500)
    } catch { /* noop */ }
  }, [])

  const sendCameraControl = useCallback((constraints) => {
    const conn = connRef.current
    if (!conn || !conn.open) return
    try {
      conn.send({ type: 'camera-control', pin: ADMIN_PIN, constraints })
    } catch { /* noop */ }
  }, [])

  const sendSoftwareControl = useCallback((settings) => {
    const conn = connRef.current
    if (!conn || !conn.open) return
    try {
      conn.send({ type: 'software-control', pin: ADMIN_PIN, settings })
    } catch { /* noop */ }
  }, [])

  const pickMimeType = useCallback(() => {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    return candidates.find((m) => {
      try { return window.MediaRecorder && MediaRecorder.isTypeSupported(m) } catch { return false }
    })
  }, [])

  const downloadBlob = useCallback((blob, suffix) => {
    try {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `hawk-${roomId}-${suffix}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { /* noop */ }
  }, [roomId])

  const startRecording = useCallback((mode = 'normal') => {
    setRecordError('')
    const stream = videoRef.current?.srcObject
    if (!stream) { setRecordError('No live stream to record yet.'); return }
    const mimeType = pickMimeType()
    if (!mimeType) { setRecordError('Recording is not supported in this browser.'); return }

    if (mode === 'normal') {
      let recorder
      try {
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 })
      } catch { setRecordError('Failed to start recorder.'); return }
      recorderChunksRef.current = []
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recorderChunksRef.current.push(ev.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(recorderChunksRef.current, { type: mimeType })
        recorderChunksRef.current = []
        downloadBlob(blob, 'rec')
      }
      try {
        recorder.start(1000)
        recorderRef.current = recorder
        setRecordMode('normal')
        setIsRecording(true)
      } catch { setRecordError('Failed to start recorder.') }
      return
    }

    // Timelapse: draw source frames onto a canvas at an adaptive interval,
    // then encode the canvas.captureStream at 30fps. Longer recording =>
    // larger sample interval => bigger speed-up factor.
    const videoEl = videoRef.current
    const w = videoEl?.videoWidth || 1280
    const h = videoEl?.videoHeight || 720
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) { setRecordError('Canvas not available.'); return }
    const outFps = 30
    const outStream = canvas.captureStream(outFps)
    let recorder
    try {
      recorder = new MediaRecorder(outStream, { mimeType, videoBitsPerSecond: 4_000_000 })
    } catch { setRecordError('Failed to start timelapse recorder.'); return }
    recorderChunksRef.current = []
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recorderChunksRef.current.push(ev.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(recorderChunksRef.current, { type: mimeType })
      recorderChunksRef.current = []
      downloadBlob(blob, 'timelapse')
    }

    // Adaptive sampling: interval grows with elapsed real time so a 1 hour
    // recording compresses to roughly a couple of minutes regardless of length.
    // Step pattern (real seconds between sampled frames):
    //   0–60s   : every 250ms  (4x)
    //   1–5min  : every 500ms  (15x)
    //   5–15min : every 1s     (30x)
    //   15–60min: every 2s     (60x)
    //   >1h     : every 4s     (120x)
    const startTs = performance.now()
    const sampleInterval = () => {
      const elapsedSec = (performance.now() - startTs) / 1000
      if (elapsedSec < 60) return 250
      if (elapsedSec < 300) return 500
      if (elapsedSec < 900) return 1000
      if (elapsedSec < 3600) return 2000
      return 4000
    }
    let stopped = false
    const tick = () => {
      if (stopped) return
      try {
        if (videoEl && videoEl.readyState >= 2) {
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height)
        }
      } catch { /* noop */ }
      timelapseRef.current.timer = setTimeout(tick, sampleInterval())
    }

    timelapseRef.current = {
      stop: () => {
        stopped = true
        if (timelapseRef.current?.timer) clearTimeout(timelapseRef.current.timer)
        try { outStream.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
      },
      timer: null,
    }
    try {
      recorder.start(1000)
      recorderRef.current = recorder
      setRecordMode('timelapse')
      setIsRecording(true)
      tick()
    } catch {
      setRecordError('Failed to start timelapse recorder.')
      timelapseRef.current?.stop()
      timelapseRef.current = null
    }
  }, [pickMimeType, downloadBlob])

  const stopRecording = useCallback(() => {
    const r = recorderRef.current
    if (r) { try { r.stop() } catch { /* noop */ } }
    recorderRef.current = null
    if (timelapseRef.current) {
      try { timelapseRef.current.stop() } catch { /* noop */ }
      timelapseRef.current = null
    }
    setIsRecording(false)
    setRecordMode('')
  }, [])

  useEffect(() => {
    let activeConn = null
    let activeCall = null
    let gotStream = false
    let cancelled = false
    let ended = false

    const clearTimers = () => {
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      if (streamTimerRef.current) { clearTimeout(streamTimerRef.current); streamTimerRef.current = null }
    }

    const stopMedia = () => {
      if (recorderRef.current) {
        try { recorderRef.current.stop() } catch { /* noop */ }
        recorderRef.current = null
      }
      if (timelapseRef.current) {
        try { timelapseRef.current.stop() } catch { /* noop */ }
        timelapseRef.current = null
      }
      if (!videoRef.current?.srcObject) return
      const s = videoRef.current.srcObject
      s.getTracks().forEach((t) => t.stop())
      videoRef.current.srcObject = null
    }

    const cleanupPeer = () => {
      if (activeCall) { activeCall.close(); activeCall = null }
      if (activeConn) { activeConn.close(); activeConn = null }
      if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null }
    }

    const markEnded = () => {
      ended = true
      cancelled = true
      clearTimers()
      endPtt()
      cleanupPeer()
      stopMedia()
      setStatus('ended')
      setError('')
    }

    const scheduleReconnect = (message) => {
      if (cancelled || ended) return
      clearTimers()
      endPtt()
      cleanupPeer()
      if (!navigator.onLine) {
        setStatus('offline')
        setError('Network is offline. Waiting for connection...')
        return
      }
      attemptRef.current += 1
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(attemptRef.current - 1, 4))
      setStatus('reconnecting')
      setError(message)
      reconnectTimerRef.current = window.setTimeout(connect, delayMs)
    }

    const connect = () => {
      if (cancelled || ended) return
      clearTimers()
      endPtt()
      cleanupPeer()
      gotStream = false
      if (!navigator.onLine) {
        setStatus('offline')
        setError('Network is offline. Waiting for connection...')
        return
      }
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting')
      setError('')

      const peer = new Peer({ debug: 0 })
      peerRef.current = peer

      peer.on('open', () => {
        if (cancelled || ended) return
        const conn = peer.connect(roomId, { reliable: true })
        activeConn = conn
        connRef.current = conn

        conn.on('open', () => {
          if (cancelled || ended) return
          setStatus('waiting')
          if (isAdminMode) {
            try { conn.send({ type: 'camera-capabilities-request', pin: ADMIN_PIN }) } catch { /* noop */ }
          }
        })
        conn.on('data', (data) => {
          if (!data || typeof data !== 'object') return
          if (data.type === 'bye') markEnded()
          else if (data.type === 'camera-capabilities') {
            setCaps(data.caps || null)
            setControlError('')
          } else if (data.type === 'camera-control-error') {
            setControlError(data.message || 'Control rejected')
          }
        })
        conn.on('close', () => {
          if (connRef.current === conn) connRef.current = null
          if (!gotStream) scheduleReconnect('Broadcaster not reachable. Retrying...')
        })
        conn.on('error', () => scheduleReconnect('Could not connect. Retrying...'))
      })

      peer.on('call', (call) => {
        activeCall = call
        call.answer()
        call.on('stream', (remote) => {
          gotStream = true
          attemptRef.current = 0
          clearTimers()
          setError('')
          if (videoRef.current) {
            videoRef.current.srcObject = remote
            videoRef.current.play().catch(() => {})
            setStatus('live')
          }
          const pc = call.peerConnection
          if (pc) {
            pc.addEventListener('iceconnectionstatechange', () => {
              const s = pc.iceConnectionState
              if (s === 'disconnected') {
                try { pc.restartIce?.() } catch { /* noop */ }
              }
            })
          }
        })
        call.on('close', () => scheduleReconnect('Stream disconnected. Reconnecting...'))
        call.on('error', () => scheduleReconnect('Stream interrupted. Reconnecting...'))
      })

      peer.on('disconnected', () => {
        // Try the cheap PeerJS reconnect first to preserve the live stream.
        try { peer.reconnect() } catch { /* noop */ }
        // If we lose the video too, scheduleReconnect will be triggered by the call/close handlers.
      })
      peer.on('close', () => { if (!cancelled && !ended) scheduleReconnect('Peer closed. Reconnecting...') })
      peer.on('error', (peerError) => {
        if (peerError.type === 'peer-unavailable') {
          scheduleReconnect('Broadcaster not live yet. Retrying...')
          return
        }
        scheduleReconnect(peerError.message || 'Failed to connect. Retrying...')
      })

      streamTimerRef.current = window.setTimeout(() => {
        if (!gotStream) scheduleReconnect('No live stream yet. Retrying...')
      }, 12000)
    }

    const onOnline = () => {
      if (ended) return
      setError('Network restored. Reconnecting...')
      setStatus('reconnecting')
      attemptRef.current = 0
      connect()
    }
    const onOffline = () => {
      if (ended) return
      clearTimers()
      endPtt()
      cleanupPeer()
      setStatus('offline')
      setError('Network is offline. Waiting for connection...')
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    connect()

    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      clearTimers()
      endPtt()
      cleanupPeer()
      stopMedia()
    }
  }, [roomId, endPtt, isAdminMode])

  const statusIcon = () => {
    if (status === 'live') return <span className="dot" />
    if (status === 'offline') return <WifiOff size={14} />
    if (status === 'reconnecting' || status === 'connecting' || status === 'waiting')
      return <Loader2 size={14} className="spin" />
    if (status === 'ended') return <AlertTriangle size={14} />
    return <Wifi size={14} />
  }

  const statusText = () => {
    switch (status) {
      case 'connecting': return 'Connecting'
      case 'waiting': return 'Waiting for video'
      case 'live': return 'Live'
      case 'reconnecting': return 'Reconnecting'
      case 'offline': return 'Offline'
      case 'ended': return 'Stream ended'
      default: return ''
    }
  }

  return (
    <div className="app viewerApp" ref={containerRef}>
      <header className="topbar">
        <Link to="/" className="iconLink" title="Back">
          <ArrowLeft size={18} />
          <span>Hawk</span>
        </Link>
        <div className="topbar-status">
          <span className={`badge ${status === 'live' ? 'badge-live' : status === 'ended' ? 'badge-danger' : 'badge-soft'}`}>
            {statusIcon()} {statusText()}
          </span>
          <span className="badge badge-soft mono">{roomId}</span>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="iconLink iconLink-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        </div>
      </header>

      <div className="viewerStage">
        <video
          ref={videoRef}
          autoPlay playsInline
          disablePictureInPicture
          controlsList="nodownload noplaybackrate nofullscreen"
          className="viewerVideo"
          onContextMenu={(e) => e.preventDefault()}
        />

        {status === 'ended' && (
          <div className="overlay">
            <div className="overlayCard">
              <AlertTriangle size={28} />
              <h2>Stream has ended</h2>
              <p>The broadcaster has stopped this stream.</p>
            </div>
          </div>
        )}

        {(status === 'connecting' || status === 'waiting' || status === 'reconnecting' || status === 'offline') && (
          <div className="overlay overlay-light">
            <div className="overlayCard">
              {status === 'offline' ? <WifiOff size={28} /> : <Loader2 size={28} className="spin" />}
              <h2>{statusText()}</h2>
              {error && <p>{error}</p>}
            </div>
          </div>
        )}

        {status === 'live' && (
          <div className="viewerControls">
            {pttError && (
              <div className="toast">
                <AlertTriangle size={14} /> {pttError}
              </div>
            )}
            {isAdminMode && recordError && (
              <div className="toast">
                <AlertTriangle size={14} /> {recordError}
              </div>
            )}
            {isAdminMode && showControls && (
              <DraggablePanel className="adminCtrlWrap" storageKey="hawk.cameraControls.pos">
                {controlError && (
                  <div className="toast"><AlertTriangle size={14} /> {controlError}</div>
                )}
                <CameraControlsBoundary onClose={() => setShowControls(false)}>
                  <CameraControls
                    caps={caps}
                    onChange={(constraints) => sendCameraControl(constraints)}
                    onSoftwareChange={(settings) => sendSoftwareControl(settings)}
                    onClose={() => setShowControls(false)}
                  />
                </CameraControlsBoundary>
              </DraggablePanel>
            )}
            {isAdminMode ? (
              <div className="adminDock">
                <button
                  type="button"
                  className="dockBtn"
                  onClick={handleAdminRefresh}
                  title="Refresh broadcaster"
                  aria-label="Refresh broadcaster"
                >
                  {refreshSent ? <Check size={18} /> : <RefreshCw size={18} />}
                  <span>{refreshSent ? 'Sent' : 'Refresh'}</span>
                </button>
                <button
                  type="button"
                  className={`dockBtn ${showControls ? 'is-active' : ''}`}
                  onClick={() => setShowControls((v) => !v)}
                  title="Camera controls"
                  aria-label="Camera controls"
                >
                  <Sliders size={18} />
                  <span>Controls</span>
                </button>
                <button
                  type="button"
                  className={`dockBtn ${isRecording ? 'dockBtn-rec' : ''}`}
                  onClick={() => {
                    if (isRecording) { stopRecording(); return }
                    setShowRecMenu((v) => !v)
                  }}
                  title={isRecording ? 'Stop & save recording' : 'Record locally'}
                  aria-label="Record"
                >
                  {isRecording ? <StopCircle size={18} /> : <Disc size={18} />}
                  <span>{isRecording ? (recordMode === 'timelapse' ? 'Stop TL' : 'Stop') : 'Record'}</span>
                </button>
                <button
                  type="button"
                  className={`dockBtn dockBtn-ptt ${pttSpeaking ? 'speaking' : ''}`}
                  onPointerDown={(e) => { e.preventDefault(); handlePttDown() }}
                  onPointerUp={handlePttUp}
                  onPointerLeave={handlePttUp}
                  onPointerCancel={handlePttUp}
                  title="Hold to talk"
                  aria-label="Push to talk"
                >
                  {pttSpeaking ? <Mic size={18} /> : <MicOff size={18} />}
                  <span>{pttSpeaking ? 'Talking' : 'Talk'}</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`pttButton ${pttSpeaking ? 'speaking' : ''}`}
                onPointerDown={(e) => { e.preventDefault(); handlePttDown() }}
                onPointerUp={handlePttUp}
                onPointerLeave={handlePttUp}
                onPointerCancel={handlePttUp}
                title="Hold to talk"
                aria-label="Push to talk"
              >
                {pttSpeaking ? <Mic size={22} /> : <MicOff size={22} />}
                <span>{pttSpeaking ? 'Talking' : 'Hold to Talk'}</span>
              </button>
            )}
            {isAdminMode && showRecMenu && !isRecording && (
              <div className="recMenu">
                <button
                  type="button"
                  className="recMenuItem"
                  onClick={() => { setShowRecMenu(false); startRecording('normal') }}
                >
                  <Disc size={16} />
                  <div>
                    <div className="recMenuTitle">Normal recording</div>
                    <div className="recMenuSub">Real-time .webm</div>
                  </div>
                </button>
                <button
                  type="button"
                  className="recMenuItem"
                  onClick={() => { setShowRecMenu(false); startRecording('timelapse') }}
                >
                  <Disc size={16} />
                  <div>
                    <div className="recMenuTitle">Timelapse</div>
                    <div className="recMenuSub">Adaptive speed-up by length</div>
                  </div>
                </button>
              </div>
            )}
            {isAdminMode && isRecording && (
              <span className="recBadge recBadge-float">
                <span className="dot" /> {recordMode === 'timelapse' ? 'REC · TIMELAPSE' : 'REC'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

function PreviewVideo({ stream }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream || null
    if (stream) el.play().catch(() => {})
  }, [stream])
  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      className="thumbVideo"
    />
  )
}

function DraggablePanel({ className = '', storageKey, children }) {
  const wrapRef = useRef(null)
  const [pos, setPos] = useState(() => {
    if (!storageKey) return null
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed
    } catch { /* noop */ }
    return null
  })
  const dragRef = useRef(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const onPointerDown = (e) => {
      const handle = e.target.closest('[data-drag-handle="true"]')
      if (!handle || !wrap.contains(handle)) return
      // Ignore drags that start on interactive controls inside the handle.
      if (e.target.closest('button, a, input, select, textarea')) return
      if (e.button !== undefined && e.button !== 0) return
      const rect = wrap.getBoundingClientRect()
      dragRef.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        width: rect.width,
        height: rect.height,
      }
      // Seed position so the first move doesn't jump.
      setPos((prev) => prev || { x: rect.left, y: rect.top })
      try { handle.setPointerCapture(e.pointerId) } catch { /* noop */ }
      handle.style.cursor = 'grabbing'
      e.preventDefault()
    }

    const onPointerMove = (e) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      const margin = 8
      const maxX = window.innerWidth - d.width - margin
      const maxY = window.innerHeight - d.height - margin
      const x = Math.min(Math.max(margin, e.clientX - d.offsetX), Math.max(margin, maxX))
      const y = Math.min(Math.max(margin, e.clientY - d.offsetY), Math.max(margin, maxY))
      setPos({ x, y })
    }

    const onPointerUp = (e) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      dragRef.current = null
      const handle = e.target.closest('[data-drag-handle="true"]')
      if (handle) {
        handle.style.cursor = ''
        try { handle.releasePointerCapture(e.pointerId) } catch { /* noop */ }
      }
      if (storageKey) {
        setPos((current) => {
          if (current && typeof current.x === 'number') {
            try { window.localStorage.setItem(storageKey, JSON.stringify(current)) } catch { /* noop */ }
          }
          return current
        })
      }
    }

    wrap.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      wrap.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [storageKey])

  // Keep panel in-viewport across window resizes.
  useEffect(() => {
    if (!pos) return
    const onResize = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      const margin = 8
      const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
      const maxY = Math.max(margin, window.innerHeight - rect.height - margin)
      setPos((p) => p ? { x: Math.min(p.x, maxX), y: Math.min(p.y, maxY) } : p)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos])

  const style = pos
    ? { position: 'fixed', left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto', margin: 0, zIndex: 60 }
    : undefined

  return (
    <div ref={wrapRef} className={`${className} draggablePanel${pos ? ' isDragged' : ''}`} style={style}>
      {children}
    </div>
  )
}

class CameraControlsBoundary extends Component {  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { console.error('CameraControls error', error) }
  render() {
    if (this.state.error) {
      return (
        <div className="ctrlPanel">
          <div className="ctrlHeader" data-drag-handle="true">
            <span><Sliders size={14} /> Camera controls</span>
            <button type="button" className="iconBtn" onClick={this.props.onClose} aria-label="Close">
              <ChevronUp size={14} />
            </button>
          </div>
          <p className="ctrlEmpty">Controls failed to render. Try refreshing the broadcaster.</p>
        </div>
      )
    }
    return this.props.children
  }
}

function CameraControls({ caps, onChange, onSoftwareChange, onClose }) {
  // Normalize: caps may be legacy hardware-only map, or { hardware, software }
  const hardware = caps && (caps.hardware !== undefined || caps.software !== undefined)
    ? caps.hardware
    : (caps || null)
  const software = caps && caps.software ? caps.software : null
  const hwEntries = hardware ? Object.entries(hardware) : []
  return (
    <div className="ctrlPanel">
      <div className="ctrlHeader" data-drag-handle="true">
        <span><Sliders size={14} /> Camera controls</span>
        <button type="button" className="iconBtn" onClick={onClose} aria-label="Close">
          <ChevronUp size={14} />
        </button>
      </div>
      {hwEntries.length === 0 && (
        <p className="ctrlEmpty">No hardware controls reported by this camera. Use the software adjustments below.</p>
      )}
      {hwEntries.length > 0 && (
        <>
          <div className="ctrlSection">Hardware</div>
          <div className="ctrlList">
            {hwEntries.map(([key, info]) => {
              const cap = info.capability
              const current = info.current
              if (cap && typeof cap === 'object' && 'min' in cap && 'max' in cap) {
                const step = cap.step || (cap.max - cap.min) / 100 || 0.01
                const val = typeof current === 'number' ? current : cap.min
                return (
                  <label key={key} className="ctrlRow">
                    <span className="ctrlLabel">{key}</span>
                    <input
                      type="range"
                      min={cap.min}
                      max={cap.max}
                      step={step}
                      defaultValue={val}
                      onChange={(e) => onChange({ [key]: Number(e.target.value) })}
                    />
                    <span className="ctrlValue mono">{val}</span>
                  </label>
                )
              }
              if (Array.isArray(cap)) {
                return (
                  <label key={key} className="ctrlRow">
                    <span className="ctrlLabel">{key}</span>
                    <select
                      className="input"
                      defaultValue={current ?? cap[0]}
                      onChange={(e) => onChange({ [key]: e.target.value })}
                    >
                      {cap.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </label>
                )
              }
              if (typeof cap === 'boolean') {
                return (
                  <label key={key} className="ctrlRow">
                    <span className="ctrlLabel">{key}</span>
                    <input
                      type="checkbox"
                      defaultChecked={!!current}
                      onChange={(e) => onChange({ [key]: e.target.checked })}
                    />
                  </label>
                )
              }
              return null
            })}
          </div>
        </>
      )}
      {onSoftwareChange && (
        <>
          <div className="ctrlSection">Software</div>
          <div className="ctrlList">
            {Object.entries(SOFTWARE_RANGES).map(([key, def]) => {
              const val = software && typeof software[key] === 'number' ? software[key] : 1
              return (
                <label key={key} className="ctrlRow">
                  <span className="ctrlLabel">{def.label}</span>
                  <input
                    type="range"
                    min={def.min}
                    max={def.max}
                    step={def.step}
                    defaultValue={val}
                    onChange={(e) => onSoftwareChange({ [key]: Number(e.target.value) })}
                  />
                  <span className="ctrlValue mono">{val.toFixed(2)}</span>
                </label>
              )
            })}
            <button
              type="button"
              className="ctrlReset"
              onClick={() => onSoftwareChange({ ...DEFAULT_SOFTWARE_SETTINGS })}
            >
              Reset software adjustments
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function AdminDashboard({ onSignOut }) {
  const peerRef = useRef(null)
  const streamsRef = useRef(new Map())
  const connsRef = useRef(new Map())
  const watchConnsRef = useRef(new Map())
  const watchCallsRef = useRef(new Map())
  const previewsRef = useRef(new Map())
  const capsRef = useRef(new Map())
  const previewFailuresRef = useRef(new Map())
  const recordersRef = useRef(new Map())
  const timelapseRefMap = useRef(new Map())
  const recordModesRef = useRef(new Map())
  const sweeperRef = useRef(null)
  const pttRef = useRef({ peerId: null, call: null, stream: null })
  const [streams, setStreams] = useState([])
  const [previewsTick, setPreviewsTick] = useState(0)
  const [adminStatus, setAdminStatus] = useState('connecting')
  const [adminError, setAdminError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [pttActiveRoom, setPttActiveRoom] = useState('')
  const [pttSpeaking, setPttSpeaking] = useState(false)
  const [pttError, setPttError] = useState('')
  const [adoptInput, setAdoptInput] = useState('')
  const [openControls, setOpenControls] = useState('')
  const [openRecMenu, setOpenRecMenu] = useState('')
  const [recordingRooms, setRecordingRooms] = useState(() => new Set())

  const publish = useCallback(() => {
    setStreams(Array.from(streamsRef.current.values()).sort((a, b) => b.startedAt - a.startedAt))
  }, [])

  const dropPreview = useCallback((roomId) => {
    const recorder = recordersRef.current.get(roomId)
    if (recorder) { try { recorder.stop() } catch { /* noop */ } }
    recordersRef.current.delete(roomId)
    setRecordingRooms((prev) => {
      if (!prev.has(roomId)) return prev
      const next = new Set(prev)
      next.delete(roomId)
      return next
    })
    capsRef.current.delete(roomId)
    const call = watchCallsRef.current.get(roomId)
    if (call) { try { call.close() } catch { /* noop */ } }
    watchCallsRef.current.delete(roomId)
    const conn = watchConnsRef.current.get(roomId)
    if (conn) { try { conn.close() } catch { /* noop */ } }
    watchConnsRef.current.delete(roomId)
    const stream = previewsRef.current.get(roomId)
    if (stream) stream.getTracks().forEach((t) => t.stop())
    previewsRef.current.delete(roomId)
    setPreviewsTick((t) => t + 1)
  }, [])

  const forgetRoom = useCallback((roomId) => {
    streamsRef.current.delete(roomId)
    connsRef.current.delete(roomId)
    previewFailuresRef.current.delete(roomId)
    try {
      const raw = localStorage.getItem('hawk-admin-known-rooms')
      const list = raw ? JSON.parse(raw) : []
      if (Array.isArray(list)) {
        const next = list.filter((r) => r !== roomId)
        localStorage.setItem('hawk-admin-known-rooms', JSON.stringify(next))
      }
    } catch { /* noop */ }
  }, [])

  const requestPreview = useCallback((roomId) => {
    const peer = peerRef.current
    if (!peer || peer.destroyed) return
    if (watchConnsRef.current.has(roomId)) return
    let conn
    try {
      conn = peer.connect(roomId, { reliable: true, metadata: { kind: 'admin-watch' } })
    } catch { return }
    watchConnsRef.current.set(roomId, conn)
    let opened = false
    const openTimer = setTimeout(() => {
      if (!opened) {
        // Broker never confirmed the peer — count as a failure.
        const n = (previewFailuresRef.current.get(roomId) || 0) + 1
        previewFailuresRef.current.set(roomId, n)
        try { conn.close() } catch { /* noop */ }
        if (watchConnsRef.current.get(roomId) === conn) {
          watchConnsRef.current.delete(roomId)
        }
      }
    }, 4000)
    conn.on('open', () => {
      opened = true
      clearTimeout(openTimer)
      previewFailuresRef.current.delete(roomId)
      try { conn.send({ type: 'camera-capabilities-request', pin: ADMIN_PIN }) } catch { /* noop */ }
    })
    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return
      if (data.type === 'camera-capabilities') {
        capsRef.current.set(roomId, data.caps || null)
        setPreviewsTick((t) => t + 1)
      } else if (data.type === 'bye') {
        // Broadcaster cleanly stopped — drop the tile immediately.
        forgetRoom(roomId)
        publish()
      }
    })
    const cleanup = () => {
      clearTimeout(openTimer)
      if (watchConnsRef.current.get(roomId) === conn) {
        watchConnsRef.current.delete(roomId)
      }
    }
    const recordFailure = () => {
      clearTimeout(openTimer)
      const n = (previewFailuresRef.current.get(roomId) || 0) + 1
      previewFailuresRef.current.set(roomId, n)
      cleanup()
    }
    conn.on('close', cleanup)
    conn.on('error', recordFailure)
  }, [])

  const sendCameraControl = useCallback((roomId, constraints) => {
    const conn = watchConnsRef.current.get(roomId)
    if (!conn || !conn.open) return
    try { conn.send({ type: 'camera-control', pin: ADMIN_PIN, constraints }) }
    catch { /* noop */ }
  }, [])

  const sendSoftwareControl = useCallback((roomId, settings) => {
    const conn = watchConnsRef.current.get(roomId)
    if (!conn || !conn.open) return
    try { conn.send({ type: 'software-control', pin: ADMIN_PIN, settings }) }
    catch { /* noop */ }
  }, [])

  const startRecording = useCallback((roomId, mode = 'normal') => {
    const stream = previewsRef.current.get(roomId)
    if (!stream) return
    if (recordersRef.current.has(roomId)) return
    const mimeCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    let mimeType = ''
    for (const m of mimeCandidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) { mimeType = m; break }
    }

    const buildRecorder = (src, bitrate) => {
      try {
        return mimeType
          ? new MediaRecorder(src, { mimeType, videoBitsPerSecond: bitrate })
          : new MediaRecorder(src)
      } catch { return null }
    }
    const finish = (chunks, recorder, suffix) => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
      const url = URL.createObjectURL(blob)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const a = document.createElement('a')
      a.href = url
      a.download = `hawk-${roomId}-${suffix}-${stamp}.webm`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    if (mode === 'timelapse') {
      const videoTrack = stream.getVideoTracks()[0]
      const tsettings = videoTrack?.getSettings?.() || {}
      const w = tsettings.width || 1280
      const h = tsettings.height || 720
      const videoEl = document.createElement('video')
      videoEl.muted = true
      videoEl.playsInline = true
      videoEl.autoplay = true
      videoEl.srcObject = stream
      videoEl.play().catch(() => {})
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const outStream = canvas.captureStream(30)
      const recorder = buildRecorder(outStream, 4_000_000)
      if (!recorder) return
      const chunks = []
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
      recorder.onstop = () => finish(chunks, recorder, 'timelapse')
      const startTs = performance.now()
      const sampleInterval = () => {
        const elapsedSec = (performance.now() - startTs) / 1000
        if (elapsedSec < 60) return 250
        if (elapsedSec < 300) return 500
        if (elapsedSec < 900) return 1000
        if (elapsedSec < 3600) return 2000
        return 4000
      }
      let stopped = false
      const tick = () => {
        if (stopped) return
        try {
          if (videoEl.readyState >= 2) ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height)
        } catch { /* noop */ }
        const handle = timelapseRefMap.current.get(roomId)
        if (handle) handle.timer = setTimeout(tick, sampleInterval())
      }
      timelapseRefMap.current.set(roomId, {
        stop: () => {
          stopped = true
          const h2 = timelapseRefMap.current.get(roomId)
          if (h2?.timer) clearTimeout(h2.timer)
          try { outStream.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
          try { videoEl.pause() } catch { /* noop */ }
          videoEl.srcObject = null
        },
        timer: null,
      })
      try { recorder.start(1000) } catch { return }
      recordersRef.current.set(roomId, recorder)
      recordModesRef.current.set(roomId, 'timelapse')
      tick()
      setRecordingRooms((prev) => { const next = new Set(prev); next.add(roomId); return next })
      return
    }

    const recorder = buildRecorder(stream, 2_500_000)
    if (!recorder) return
    const chunks = []
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => finish(chunks, recorder, 'rec')
    try { recorder.start(1000) } catch { return }
    recordersRef.current.set(roomId, recorder)
    recordModesRef.current.set(roomId, 'normal')
    setRecordingRooms((prev) => { const next = new Set(prev); next.add(roomId); return next })
  }, [])

  const stopRecording = useCallback((roomId) => {
    const recorder = recordersRef.current.get(roomId)
    if (recorder) { try { recorder.stop() } catch { /* noop */ } }
    recordersRef.current.delete(roomId)
    const tl = timelapseRefMap.current.get(roomId)
    if (tl) { try { tl.stop() } catch { /* noop */ } }
    timelapseRefMap.current.delete(roomId)
    recordModesRef.current.delete(roomId)
    setRecordingRooms((prev) => {
      const next = new Set(prev)
      next.delete(roomId)
      return next
    })
  }, [])

  const rememberRoom = useCallback((roomId) => {
    try {
      const raw = localStorage.getItem('hawk-admin-known-rooms')
      const list = raw ? JSON.parse(raw) : []
      if (Array.isArray(list) && !list.includes(roomId)) {
        list.push(roomId)
        // Keep most-recent 20
        const trimmed = list.slice(-20)
        localStorage.setItem('hawk-admin-known-rooms', JSON.stringify(trimmed))
      }
    } catch { /* noop */ }
  }, [])

  const adoptRoom = useCallback((roomId) => {
    const id = (roomId || '').trim()
    if (!id) return
    rememberRoom(id)
    if (!streamsRef.current.has(id)) {
      streamsRef.current.set(id, {
        roomId: id,
        title: '',
        startedAt: Date.now(),
        viewerCount: 0,
        lastSeen: Date.now(),
        peerId: null,
        adopted: true,
      })
      publish()
    }
    requestPreview(id)
  }, [publish, requestPreview, rememberRoom])

  const endPttSession = useCallback(() => {
    const s = pttRef.current
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop())
    if (s.call) { try { s.call.close() } catch { /* noop */ } }
    pttRef.current = { peerId: null, call: null, stream: null }
    setPttActiveRoom('')
    setPttSpeaking(false)
  }, [])

  const setTalking = useCallback((on) => {
    const stream = pttRef.current.stream
    if (!stream) return
    stream.getAudioTracks().forEach((t) => { t.enabled = on })
    setPttSpeaking(on)
  }, [])

  const startPttSession = useCallback(async (room) => {
    setPttError('')
    const peer = peerRef.current
    if (!peer || peer.destroyed) {
      setPttError('Admin signaling not ready.')
      return false
    }
    if (pttRef.current.peerId && pttRef.current.peerId !== room.roomId) endPttSession()
    if (pttRef.current.peerId === room.roomId && pttRef.current.call) return true

    let mic
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
    } catch {
      setPttError('Microphone permission is required for push-to-talk.')
      return false
    }
    mic.getAudioTracks().forEach((t) => { t.enabled = false })
    const call = peer.call(room.roomId, mic, { metadata: { kind: 'admin-ptt' } })
    if (!call) {
      mic.getTracks().forEach((t) => t.stop())
      setPttError('Could not place admin call.')
      return false
    }
    pttRef.current = { peerId: room.roomId, call, stream: mic }
    setPttActiveRoom(room.roomId)
    const stop = () => { if (pttRef.current.call === call) endPttSession() }
    call.on('close', stop)
    call.on('error', stop)
    return true
  }, [endPttSession])

  const handleRefresh = useCallback((room) => {
    const peer = peerRef.current
    if (!peer || peer.destroyed) {
      setAdminError('Admin peer not ready.')
      return
    }
    // Try existing channels first (cheap path).
    const presence = connsRef.current.get(room.roomId)
    const watch = watchConnsRef.current.get(room.roomId)
    const existing = (presence && presence.open) ? presence : (watch && watch.open ? watch : null)
    if (existing) {
      try { existing.send({ type: 'admin-refresh', pin: ADMIN_PIN }) } catch { /* fall through */ }
    }
    // Always also open a one-shot fresh channel so a stale/half-open conn
    // can never block the refresh — same approach the CLI script uses.
    let fresh
    try {
      fresh = peer.connect(room.roomId, { reliable: true, metadata: { kind: 'admin-refresh' } })
    } catch {
      if (!existing) setAdminError('Failed to open refresh channel.')
      return
    }
    let sent = false
    const finish = () => {
      if (!sent) return
      try { fresh.close() } catch { /* noop */ }
    }
    fresh.on('open', () => {
      try {
        fresh.send({ type: 'admin-refresh', pin: ADMIN_PIN })
        sent = true
        setAdminError('')
        setTimeout(finish, 400)
      } catch {
        if (!existing) setAdminError('Failed to send refresh command.')
      }
    })
    fresh.on('error', () => {
      if (!existing && !sent) setAdminError('Refresh channel error.')
    })
    setTimeout(() => {
      if (!sent && !existing) setAdminError('Refresh timed out (broadcaster offline?).')
      try { fresh.close() } catch { /* noop */ }
    }, 5000)
  }, [])

  const handlePttDown = useCallback(async (room) => {
    const ok = pttRef.current.peerId === room.roomId ? true : await startPttSession(room)
    if (ok) setTalking(true)
  }, [startPttSession, setTalking])

  const handlePttUp = useCallback(() => setTalking(false), [setTalking])

  useEffect(() => {
    let disposed = false
    let activePeer = null

    const attachHandlers = (peer) => {
      peer.on('call', (call) => {
        call.answer()
        call.on('stream', (remote) => {
          previewsRef.current.set(call.peer, remote)
          watchCallsRef.current.set(call.peer, call)
          previewFailuresRef.current.delete(call.peer)
          rememberRoom(call.peer)
          // When the remote stream stops, just drop the preview. The sweeper
          // will retry; if the broadcaster is truly gone the failure counter
          // will forget the room on its own.
          const onInactive = () => { dropPreview(call.peer) }
          remote.oninactive = onInactive
          if (!streamsRef.current.has(call.peer)) {
            streamsRef.current.set(call.peer, {
              roomId: call.peer,
              title: '',
              startedAt: Date.now(),
              viewerCount: 0,
              lastSeen: Date.now(),
              peerId: null,
              adopted: true,
            })
            publish()
          } else {
            const existing = streamsRef.current.get(call.peer)
            existing.lastSeen = Date.now()
          }
          setPreviewsTick((t) => t + 1)
        })
        const stop = () => {
          if (watchCallsRef.current.get(call.peer) === call) {
            watchCallsRef.current.delete(call.peer)
            previewsRef.current.delete(call.peer)
            setPreviewsTick((t) => t + 1)
            // Don't forget the room here — sweeper retries preview; if the
            // broadcaster is really gone, failure counter prunes it.
          }
        }
        call.on('close', stop)
        call.on('error', stop)
      })
      peer.on('connection', (conn) => {
        let assignedRoom = ''
        conn.on('data', (data) => {
          if (!data || typeof data !== 'object') return
          if (data.type === 'presence' && data.roomId) {
            assignedRoom = data.roomId
            const isNew = !streamsRef.current.has(data.roomId)
            connsRef.current.set(data.roomId, conn)
            streamsRef.current.set(data.roomId, {
              roomId: data.roomId,
              title: data.title || '',
              startedAt: data.startedAt || Date.now(),
              viewerCount: typeof data.viewerCount === 'number' ? data.viewerCount : 0,
              lastSeen: Date.now(),
              peerId: conn.peer,
            })
            rememberRoom(data.roomId)
            publish()
            if (isNew) requestPreview(data.roomId)
          } else if (data.type === 'bye' && data.roomId) {
            streamsRef.current.delete(data.roomId)
            connsRef.current.delete(data.roomId)
            dropPreview(data.roomId)
            publish()
          }
        })
        conn.on('close', () => {
          let changed = false
          streamsRef.current.forEach((entry, key) => {
            if (entry.peerId === conn.peer) {
              streamsRef.current.delete(key)
              connsRef.current.delete(key)
              dropPreview(key)
              changed = true
            }
          })
          if (assignedRoom) connsRef.current.delete(assignedRoom)
          if (changed) publish()
        })
      })
      peer.on('disconnected', () => { try { peer.reconnect() } catch { /* noop */ } })
    }

    const tryClaim = (index) => {
      if (disposed) return
      if (index >= ADMIN_PEER_IDS.length) {
        setAdminStatus('error')
        setAdminError('All admin slots are in use. Please close another admin tab.')
        return
      }
      const slotId = ADMIN_PEER_IDS[index]
      const peer = new Peer(slotId, { debug: 0 })
      activePeer = peer
      peerRef.current = peer
      let opened = false

      peer.on('open', () => {
        opened = true
        setAdminStatus('listening')
        setAdminError('')
      })
      peer.on('error', (err) => {
        if (err?.type === 'unavailable-id' && !opened) {
          try { peer.destroy() } catch { /* noop */ }
          tryClaim(index + 1)
          return
        }
        if (err?.type === 'network' || err?.type === 'server-error') {
          setAdminStatus('reconnecting')
          setAdminError('Signaling connection issue. Retrying...')
          return
        }
        if (err?.type === 'peer-unavailable') return
        setAdminStatus('error')
        setAdminError(err?.message || 'Admin connection failed.')
      })
      attachHandlers(peer)
    }

    tryClaim(0)

    // Auto-adopt previously seen rooms in case presence doesn't auto-register.
    try {
      const raw = localStorage.getItem('hawk-admin-known-rooms')
      const list = raw ? JSON.parse(raw) : []
      if (Array.isArray(list)) {
        list.forEach((id) => {
          if (typeof id !== 'string' || !id) return
          if (streamsRef.current.has(id)) return
          streamsRef.current.set(id, {
            roomId: id,
            title: '',
            startedAt: Date.now(),
            viewerCount: 0,
            lastSeen: Date.now(),
            peerId: null,
            adopted: true,
          })
        })
        publish()
      }
    } catch { /* noop */ }

    sweeperRef.current = setInterval(() => {
      const t = Date.now()
      let changed = false
      streamsRef.current.forEach((entry, key) => {
        const hasPreview = previewsRef.current.has(key)
        const failures = previewFailuresRef.current.get(key) || 0
        if (entry.adopted) {
          // Adopted entries are kept alive by the preview call, not presence.
          // Drop if we've failed to reach the broadcaster a couple of times
          // and we don't currently have a live preview stream.
          if (!hasPreview && failures >= 2) {
            forgetRoom(key)
            changed = true
            return
          }
          if (!hasPreview && !watchConnsRef.current.has(key) && t - entry.lastSeen > PRESENCE_TIMEOUT_MS) {
            streamsRef.current.delete(key)
            connsRef.current.delete(key)
            changed = true
          }
          return
        }
        if (t - entry.lastSeen > PRESENCE_TIMEOUT_MS) {
          streamsRef.current.delete(key)
          connsRef.current.delete(key)
          dropPreview(key)
          changed = true
        }
      })
      if (changed) publish()
      // Retry any missing previews for known streams.
      streamsRef.current.forEach((_, key) => {
        if (!previewsRef.current.has(key) && !watchConnsRef.current.has(key)) {
          requestPreview(key)
        }
      })
      setNow(Date.now())
    }, 2000)

    const streamsMap = streamsRef.current
    const connsMap = connsRef.current
    const watchConnsMap = watchConnsRef.current
    const watchCallsMap = watchCallsRef.current
    const previewsMap = previewsRef.current
    const recordersMap = recordersRef.current
    const capsMap = capsRef.current
    return () => {
      disposed = true
      if (sweeperRef.current) { clearInterval(sweeperRef.current); sweeperRef.current = null }
      endPttSession()
      recordersMap.forEach((r) => { try { r.stop() } catch { /* noop */ } })
      watchCallsMap.forEach((c) => { try { c.close() } catch { /* noop */ } })
      watchConnsMap.forEach((c) => { try { c.close() } catch { /* noop */ } })
      previewsMap.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      if (activePeer) { try { activePeer.destroy() } catch { /* noop */ } }
      peerRef.current = null
      streamsMap.clear()
      connsMap.clear()
      watchConnsMap.clear()
      watchCallsMap.clear()
      previewsMap.clear()
      recordersMap.clear()
      capsMap.clear()
    }
  }, [publish, endPttSession, requestPreview, dropPreview, rememberRoom])

  return (
    <div className="app adminApp">
      <header className="topbar">
        <div className="brand">
          <ShieldCheck size={18} strokeWidth={2.2} />
          <span>HAWK Admin</span>
        </div>
        <div className="topbar-status">
          <span className={`badge ${adminStatus === 'listening' ? 'badge-live' : adminStatus === 'error' ? 'badge-danger' : 'badge-soft'}`}>
            {adminStatus === 'listening'
              ? <><span className="dot" /> {streams.length} live</>
              : adminStatus === 'connecting'
              ? <><Loader2 size={14} className="spin" /> Connecting</>
              : adminStatus === 'reconnecting'
              ? <><Loader2 size={14} className="spin" /> Reconnecting</>
              : <><AlertTriangle size={14} /> Error</>}
          </span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="iconLink iconLink-btn" onClick={onSignOut} title="Sign out">
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      <main className="adminBody">
        {(adminError || pttError) && (
          <div className="alertBar">
            <AlertTriangle size={14} />
            <span>{adminError || pttError}</span>
          </div>
        )}

        <form
          className="adoptRow"
          onSubmit={(e) => {
            e.preventDefault()
            adoptRoom(adoptInput)
            setAdoptInput('')
          }}
        >
          <input
            type="text"
            className="input"
            placeholder="Add stream by Room ID"
            value={adoptInput}
            onChange={(e) => setAdoptInput(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
          <button type="submit" className="btn btn-primary" disabled={!adoptInput.trim()}>
            <Eye size={16} />
            <span>Add</span>
          </button>
        </form>

        {streams.length === 0 && adminStatus === 'listening' && (
          <div className="emptyState">
            <Radio size={36} />
            <h2>No active streams</h2>
            <p>Streams appear here as soon as a broadcaster goes live, or add one by Room ID above.</p>
          </div>
        )}

        <div className="grid">
          {streams.map((stream) => {
            const watchUrl = `/watch/${stream.roomId}?admin=1`
            const isPttActive = pttActiveRoom === stream.roomId
            const previewStream = previewsRef.current.get(stream.roomId)
            const caps = capsRef.current.get(stream.roomId)
            const isRecording = recordingRooms.has(stream.roomId)
            const showControls = openControls === stream.roomId
            const showRecMenu = openRecMenu === stream.roomId
            const recordMode = recordModesRef.current.get(stream.roomId) || ''
            void previewsTick
            return (
              <article key={stream.roomId} className="card-stream">
                <a href={watchUrl} target="_blank" rel="noreferrer" className="thumbLink">
                  <div className="thumb">
                    <span className="liveBadge"><span className="dot" /> LIVE</span>
                    <span className="thumbMeta"><Eye size={13} /> {stream.viewerCount}</span>
                    {isRecording && (
                      <span className="recBadge"><span className="dot" /> REC</span>
                    )}
                    {previewStream ? (
                      <PreviewVideo stream={previewStream} />
                    ) : (
                      <Camera className="thumbIcon" size={42} strokeWidth={1.4} />
                    )}
                  </div>
                </a>
                <div className="card-streamBody">
                  <div className="card-streamTitleRow">
                    <h3 className="card-streamTitle">
                      {stream.title || `Stream ${stream.roomId}`}
                    </h3>
                  </div>
                  <p className="card-streamSub mono">
                    {stream.roomId} · {formatDuration(now - stream.startedAt)}
                  </p>
                  <div className="card-streamActions">
                    <a href={watchUrl} target="_blank" rel="noreferrer" className="tileBtn tileBtn-primary" title="Open stream">
                      <ExternalLink size={15} />
                      <span>Open</span>
                    </a>
                    <button
                      type="button"
                      className="tileBtn"
                      onClick={() => handleRefresh(stream)}
                      title="Refresh broadcaster"
                    >
                      <RefreshCw size={15} />
                      <span>Refresh</span>
                    </button>
                    <button
                      type="button"
                      className={`tileBtn tileBtn-ptt ${isPttActive && pttSpeaking ? 'speaking' : ''}`}
                      onPointerDown={(e) => { e.preventDefault(); handlePttDown(stream) }}
                      onPointerUp={handlePttUp}
                      onPointerLeave={handlePttUp}
                      onPointerCancel={handlePttUp}
                      title="Hold to talk"
                    >
                      {isPttActive && pttSpeaking ? <Mic size={15} /> : <MicOff size={15} />}
                      <span>{isPttActive && pttSpeaking ? 'Talking' : 'Hold to Talk'}</span>
                    </button>
                  </div>
                  <div className="card-streamActions card-streamActions-sub">
                    <div className="tileRecWrap">
                      <button
                        type="button"
                        className={`tileBtn ${isRecording ? 'tileBtn-rec' : ''}`}
                        onClick={() => {
                          if (isRecording) { stopRecording(stream.roomId); return }
                          setOpenRecMenu(showRecMenu ? '' : stream.roomId)
                        }}
                        disabled={!previewStream}
                        title={previewStream ? (isRecording ? 'Stop & save recording' : 'Record locally') : 'Waiting for preview'}
                      >
                        {isRecording ? <StopCircle size={15} /> : <Disc size={15} />}
                        <span>{isRecording ? (recordMode === 'timelapse' ? 'Stop TL' : 'Stop & Save') : 'Record'}</span>
                      </button>
                      {showRecMenu && !isRecording && (
                        <div className="recMenu recMenu-tile">
                          <button
                            type="button"
                            className="recMenuItem"
                            onClick={() => { setOpenRecMenu(''); startRecording(stream.roomId, 'normal') }}
                          >
                            <Disc size={14} />
                            <div>
                              <div className="recMenuTitle">Normal</div>
                              <div className="recMenuSub">Real-time .webm</div>
                            </div>
                          </button>
                          <button
                            type="button"
                            className="recMenuItem"
                            onClick={() => { setOpenRecMenu(''); startRecording(stream.roomId, 'timelapse') }}
                          >
                            <Disc size={14} />
                            <div>
                              <div className="recMenuTitle">Timelapse</div>
                              <div className="recMenuSub">Adaptive speed-up</div>
                            </div>
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="tileBtn"
                      onClick={() => setOpenControls(showControls ? '' : stream.roomId)}
                      title="Camera controls"
                    >
                      <Sliders size={15} />
                      <span>Controls</span>
                      {showControls ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                  </div>
                  {showControls && (
                    <DraggablePanel
                      className="adminCardCtrlWrap"
                      storageKey={`hawk.cameraControls.admin.${stream.roomId}.pos`}
                    >
                      <CameraControlsBoundary onClose={() => setOpenControls('')}>
                        <CameraControls
                          caps={caps}
                          onChange={(constraints) => sendCameraControl(stream.roomId, constraints)}
                          onSoftwareChange={(settings) => sendSoftwareControl(stream.roomId, settings)}
                          onClose={() => setOpenControls('')}
                        />
                      </CameraControlsBoundary>
                    </DraggablePanel>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </main>
    </div>
  )
}

function AdminPage() {
  const navigate = useNavigate()
  const [unlocked, setUnlocked] = useState(() => {
    try { return sessionStorage.getItem('hawk-admin-unlocked') === '1' } catch { return false }
  })
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')

  const submitPin = (e) => {
    e.preventDefault()
    if (pin === ADMIN_PIN) {
      try { sessionStorage.setItem('hawk-admin-unlocked', '1') } catch { /* noop */ }
      setUnlocked(true)
      setPinError('')
      setPin('')
    } else {
      setPinError('Incorrect PIN.')
      setPin('')
    }
  }

  const signOut = () => {
    try { sessionStorage.removeItem('hawk-admin-unlocked') } catch { /* noop */ }
    setUnlocked(false)
    navigate('/admin')
  }

  if (!unlocked) {
    return (
      <div className="app pinApp">
        <div className="pinCard">
          <div className="pinIcon"><Lock size={22} /></div>
          <h1>Admin access</h1>
          <p className="pinSubtext">Enter the admin PIN to continue.</p>
          <form onSubmit={submitPin} className="pinForm">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="input pinInput"
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn btn-primary">
              <ShieldCheck size={16} />
              <span>Unlock</span>
            </button>
          </form>
          {pinError && (
            <p className="alert">
              <AlertTriangle size={14} /> {pinError}
            </p>
          )}
          <Link to="/" className="pinBack">
            <ArrowLeft size={14} /> Back to broadcaster
          </Link>
        </div>
      </div>
    )
  }

  return <AdminDashboard onSignOut={signOut} />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<BroadcasterPage />} />
        <Route path="/watch/:roomId" element={<ViewerPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
