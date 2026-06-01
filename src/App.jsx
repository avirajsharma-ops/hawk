import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
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
} from 'lucide-react'
import './App.css'

// Well-known PeerJS ID for the admin presence registry.
const ADMIN_PEER_ID = 'hawk-admin-presence-mwhawk-v1'
const ADMIN_PIN = '2001'
const PRESENCE_HEARTBEAT_MS = 5000
const PRESENCE_TIMEOUT_MS = 15000
const ADMIN_RETRY_MS = 4000
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

async function acquireStream(deviceId) {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
  const videoAttempts = []
  if (deviceId) {
    videoAttempts.push({
      deviceId: { exact: deviceId },
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
    })
    videoAttempts.push({
      deviceId: { exact: deviceId },
      width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 },
    })
    videoAttempts.push({ deviceId: { exact: deviceId } })
    videoAttempts.push({ deviceId })
  }
  videoAttempts.push({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } })
  videoAttempts.push({ width: { ideal: 640 }, height: { ideal: 480 } })
  videoAttempts.push(true)

  let lastError = null
  for (const video of videoAttempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio })
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
  const wakeLockRef = useRef(null)
  const statusRef = useRef('idle')
  const activeCallsRef = useRef(new Set())
  const viewerConnsRef = useRef(new Set())
  const adminConnRef = useRef(null)
  const adminHeartbeatRef = useRef(null)
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

  useEffect(() => { statusRef.current = status }, [status])

  const shareUrl = useMemo(() => {
    if (!roomId) return ''
    return `${window.location.origin}/watch/${roomId}`
  }, [roomId])

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cameraDevices = devices
      .filter((d) => d.kind === 'videoinput')
      .map((device, index) => {
        const { isUsb, isBuiltIn } = classifyCamera(device, devices)
        return {
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
          isUsb, isBuiltIn,
        }
      })
    setCameras(cameraDevices)
    setSelectedCameraId((current) => {
      if (current && cameraDevices.some((c) => c.deviceId === current)) return current
      const usb = cameraDevices.find((c) => c.isUsb)
      return usb?.deviceId || cameraDevices[0]?.deviceId || ''
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

  const sendPresence = useCallback(() => {
    const conn = adminConnRef.current
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
  }, [])

  const closeAdminPresence = useCallback(() => {
    if (adminHeartbeatRef.current) {
      clearInterval(adminHeartbeatRef.current)
      adminHeartbeatRef.current = null
    }
    if (adminConnRef.current) {
      try { adminConnRef.current.close() } catch { /* noop */ }
      adminConnRef.current = null
    }
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
    closeAdminPresence()

    let conn
    try {
      conn = peer.connect(ADMIN_PEER_ID, { reliable: true, serialization: 'json' })
    } catch {
      retryLater()
      return
    }
    adminConnRef.current = conn

    const scheduleRetry = () => {
      closeAdminPresence()
      if (statusRef.current === 'live' || statusRef.current === 'starting') {
        retryLater()
      }
    }

    conn.on('open', () => {
      sendPresence()
      adminHeartbeatRef.current = setInterval(sendPresence, PRESENCE_HEARTBEAT_MS)
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
    conn.on('close', scheduleRetry)
    conn.on('error', scheduleRetry)
  }, [closeAdminPresence, sendPresence, selectedCameraId])

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

    try {
      const localStream = await acquireStream(desiredCameraId)
      streamRef.current = localStream
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
          viewerConnsRef.current.add(conn)
          const dropConn = () => viewerConnsRef.current.delete(conn)
          conn.on('close', dropConn)
          conn.on('error', dropConn)

          conn.on('open', () => {
            const call = peer.call(conn.peer, streamRef.current || localStream)
            if (!call) return
            activeCallsRef.current.add(call)
            setViewerCount(activeCallsRef.current.size)
            sendPresence()

            const tune = () => tuneSenderBitrate(call)
            if (call.peerConnection) {
              call.peerConnection.addEventListener('connectionstatechange', () => {
                if (call.peerConnection.connectionState === 'connected') tune()
              })
              setTimeout(tune, 1500)
            }

            const dropCall = () => {
              activeCallsRef.current.delete(call)
              setViewerCount(activeCallsRef.current.size)
              sendPresence()
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
          if (peerError?.type === 'unavailable-id' && attempt < 6) {
            try { peer.destroy() } catch { /* noop */ }
            setTimeout(() => createPeer(attempt + 1), 2000)
            return
          }
          const nonFatal = new Set([
            'peer-unavailable', 'network', 'server-error',
            'disconnected', 'socket-error', 'socket-closed',
          ])
          if (nonFatal.has(peerError?.type)) {
            if (peerError?.type === 'peer-unavailable') {
              closeAdminPresence()
              if (adminRetryRef.current) clearTimeout(adminRetryRef.current)
              adminRetryRef.current = setTimeout(
                () => connectAdminPresenceRef.current(),
                ADMIN_RETRY_MS
              )
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
    } catch {
      setError('Camera/microphone permission is required to go live.')
      setStatus('idle')
    }
  }, [
    streamTitle, selectedCameraId, refreshCameras,
    requestWakeLock, connectAdminPresence, closeAdminPresence, sendPresence,
  ])

  useEffect(() => { startBroadcastRef.current = startBroadcast }, [startBroadcast])

  const stopBroadcast = () => {
    viewerConnsRef.current.forEach((conn) => {
      if (conn.open) {
        try { conn.send({ type: 'bye', reason: 'broadcaster-stopped' }) } catch { /* noop */ }
      }
    })
    if (adminConnRef.current?.open) {
      try {
        adminConnRef.current.send({
          type: 'bye', roomId: presenceStateRef.current.roomId,
        })
      } catch { /* noop */ }
    }
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

    return () => {
      clearTimeout(initialRefresh)
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
      releaseWakeLock()
    }
  }, [refreshCameras, releaseWakeLock, requestWakeLock, closeAdminPresence])

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
            {streamRef.current ? null : (
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
                  </>
                )}
              </div>
            )}
            <video
              ref={previewRef}
              autoPlay playsInline muted
              className={`stageVideo ${isLive || isStarting ? 'visible' : ''}`}
            />
            <audio ref={adminAudioRef} autoPlay playsInline />

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
                      {c.label}{c.isUsb ? ' — USB' : c.isBuiltIn ? ' — Built-in' : ''}
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
  const containerRef = useRef(null)
  const videoRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const streamTimerRef = useRef(null)
  const attemptRef = useRef(0)
  const peerRef = useRef(null)
  const pttCallRef = useRef(null)
  const pttStreamRef = useRef(null)
  const [status, setStatus] = useState('connecting')
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pttSpeaking, setPttSpeaking] = useState(false)
  const [pttError, setPttError] = useState('')

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

        conn.on('open', () => { if (!cancelled && !ended) setStatus('waiting') })
        conn.on('data', (data) => {
          if (data && typeof data === 'object' && data.type === 'bye') markEnded()
        })
        conn.on('close', () => {
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
        })
        call.on('close', () => scheduleReconnect('Stream disconnected. Reconnecting...'))
        call.on('error', () => scheduleReconnect('Stream interrupted. Reconnecting...'))
      })

      peer.on('disconnected', () => scheduleReconnect('Connection lost. Reconnecting...'))
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
  }, [roomId, endPtt])

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
          autoPlay playsInline controls
          className="viewerVideo"
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
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

function AdminDashboard({ onSignOut }) {
  const peerRef = useRef(null)
  const streamsRef = useRef(new Map())
  const connsRef = useRef(new Map())
  const sweeperRef = useRef(null)
  const pttRef = useRef({ peerId: null, call: null, stream: null })
  const [streams, setStreams] = useState([])
  const [adminStatus, setAdminStatus] = useState('connecting')
  const [adminError, setAdminError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [pttActiveRoom, setPttActiveRoom] = useState('')
  const [pttSpeaking, setPttSpeaking] = useState(false)
  const [pttError, setPttError] = useState('')

  const publish = useCallback(() => {
    setStreams(Array.from(streamsRef.current.values()).sort((a, b) => b.startedAt - a.startedAt))
  }, [])

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
    const conn = connsRef.current.get(room.roomId)
    if (!conn || !conn.open) {
      setAdminError('Broadcaster channel not available for refresh.')
      return
    }
    try { conn.send({ type: 'admin-refresh' }) }
    catch { setAdminError('Failed to send refresh command.') }
  }, [])

  const handlePttDown = useCallback(async (room) => {
    const ok = pttRef.current.peerId === room.roomId ? true : await startPttSession(room)
    if (ok) setTalking(true)
  }, [startPttSession, setTalking])

  const handlePttUp = useCallback(() => setTalking(false), [setTalking])

  useEffect(() => {
    const peer = new Peer(ADMIN_PEER_ID, { debug: 0 })
    peerRef.current = peer
    peer.on('open', () => setAdminStatus('listening'))
    peer.on('connection', (conn) => {
      let assignedRoom = ''
      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return
        if (data.type === 'presence' && data.roomId) {
          assignedRoom = data.roomId
          connsRef.current.set(data.roomId, conn)
          streamsRef.current.set(data.roomId, {
            roomId: data.roomId,
            title: data.title || '',
            startedAt: data.startedAt || Date.now(),
            viewerCount: typeof data.viewerCount === 'number' ? data.viewerCount : 0,
            lastSeen: Date.now(),
            peerId: conn.peer,
          })
          publish()
        } else if (data.type === 'bye' && data.roomId) {
          streamsRef.current.delete(data.roomId)
          connsRef.current.delete(data.roomId)
          publish()
        }
      })
      conn.on('close', () => {
        let changed = false
        streamsRef.current.forEach((entry, key) => {
          if (entry.peerId === conn.peer) {
            streamsRef.current.delete(key)
            connsRef.current.delete(key)
            changed = true
          }
        })
        if (assignedRoom) connsRef.current.delete(assignedRoom)
        if (changed) publish()
      })
    })
    peer.on('error', (err) => {
      if (err?.type === 'unavailable-id') {
        setAdminStatus('conflict')
        setAdminError('Another admin dashboard is already running. Close it and reload.')
        return
      }
      if (err?.type === 'network' || err?.type === 'server-error') {
        setAdminStatus('reconnecting')
        setAdminError('Signaling connection issue. Retrying...')
        return
      }
      setAdminStatus('error')
      setAdminError(err?.message || 'Admin connection failed.')
    })
    peer.on('disconnected', () => { try { peer.reconnect() } catch { /* noop */ } })

    sweeperRef.current = setInterval(() => {
      const t = Date.now()
      let changed = false
      streamsRef.current.forEach((entry, key) => {
        if (t - entry.lastSeen > PRESENCE_TIMEOUT_MS) {
          streamsRef.current.delete(key)
          connsRef.current.delete(key)
          changed = true
        }
      })
      if (changed) publish()
      setNow(Date.now())
    }, 2000)

    const streamsMap = streamsRef.current
    const connsMap = connsRef.current
    return () => {
      if (sweeperRef.current) { clearInterval(sweeperRef.current); sweeperRef.current = null }
      endPttSession()
      if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null }
      streamsMap.clear()
      connsMap.clear()
    }
  }, [publish, endPttSession])

  return (
    <div className="app adminApp">
      <header className="topbar">
        <div className="brand">
          <ShieldCheck size={18} strokeWidth={2.2} />
          <span>HAWK Admin</span>
        </div>
        <div className="topbar-status">
          <span className={`badge ${adminStatus === 'listening' ? 'badge-live' : adminStatus === 'conflict' || adminStatus === 'error' ? 'badge-danger' : 'badge-soft'}`}>
            {adminStatus === 'listening'
              ? <><span className="dot" /> {streams.length} live</>
              : adminStatus === 'connecting'
              ? <><Loader2 size={14} className="spin" /> Connecting</>
              : adminStatus === 'reconnecting'
              ? <><Loader2 size={14} className="spin" /> Reconnecting</>
              : adminStatus === 'conflict'
              ? <><AlertTriangle size={14} /> Conflict</>
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

        {streams.length === 0 && adminStatus === 'listening' && (
          <div className="emptyState">
            <Radio size={36} />
            <h2>No active streams</h2>
            <p>Streams appear here as soon as a broadcaster goes live.</p>
          </div>
        )}

        <div className="grid">
          {streams.map((stream) => {
            const watchUrl = `/watch/${stream.roomId}`
            const isPttActive = pttActiveRoom === stream.roomId
            return (
              <article key={stream.roomId} className="card-stream">
                <a href={watchUrl} target="_blank" rel="noreferrer" className="thumbLink">
                  <div className="thumb">
                    <span className="liveBadge"><span className="dot" /> LIVE</span>
                    <span className="thumbMeta"><Eye size={13} /> {stream.viewerCount}</span>
                    <Camera className="thumbIcon" size={42} strokeWidth={1.4} />
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
