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
import './App.css'

// Well-known PeerJS ID for the admin presence registry. Only one admin
// dashboard can hold this ID at a time on the PeerJS public broker.
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
  } catch {
    // storage may be unavailable; non-fatal
  }
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

  if (BUILTIN_HINTS.test(searchable)) {
    return { isUsb: false, isBuiltIn: true }
  }
  if (USB_HINTS.test(searchable)) {
    return { isUsb: true, isBuiltIn: false }
  }
  const videoCount = allDevices.filter((d) => d.kind === 'videoinput').length
  if (videoCount === 1 && device.label) {
    return { isUsb: true, isBuiltIn: false }
  }
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
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    })
    videoAttempts.push({
      deviceId: { exact: deviceId },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 },
    })
    videoAttempts.push({ deviceId: { exact: deviceId } })
    videoAttempts.push({ deviceId })
  }
  videoAttempts.push({
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  })
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
  } catch {
    // best-effort
  }
}

function HomePage() {
  return (
    <main className="page">
      <BroadcasterPage />
      <p className="adminFooter">
        <Link to="/admin">Admin dashboard</Link>
      </p>
    </main>
  )
}

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
  const [wakeLockEnabled, setWakeLockEnabled] = useState(false)
  const [resolution, setResolution] = useState('')
  const [viewerCount, setViewerCount] = useState(0)
  const [copyState, setCopyState] = useState('idle')
  const [streamTitle, setStreamTitle] = useState('')
  const [adminTalking, setAdminTalking] = useState(false)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const shareUrl = useMemo(() => {
    if (!roomId) return ''
    return `${window.location.origin}/watch/${roomId}`
  }, [roomId])

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return

    const devices = await navigator.mediaDevices.enumerateDevices()
    const cameraDevices = devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => {
        const { isUsb, isBuiltIn } = classifyCamera(device, devices)
        return {
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
          isUsb,
          isBuiltIn,
        }
      })

    setCameras(cameraDevices)

    setSelectedCameraId((current) => {
      if (current && cameraDevices.some((c) => c.deviceId === current)) {
        return current
      }
      const usb = cameraDevices.find((c) => c.isUsb)
      return usb?.deviceId || cameraDevices[0]?.deviceId || ''
    })
  }, [])

  const unlockLabels = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      probe.getTracks().forEach((t) => t.stop())
    } catch {
      // permission denied; still try to enumerate
    }
    await refreshCameras()
  }, [refreshCameras])

  const releaseWakeLock = useCallback(async () => {
    if (!wakeLockRef.current) return
    await wakeLockRef.current.release().catch(() => {})
    wakeLockRef.current = null
    setWakeLockEnabled(false)
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator) || wakeLockRef.current) return
    try {
      const wakeLock = await navigator.wakeLock.request('screen')
      wakeLockRef.current = wakeLock
      setWakeLockEnabled(true)
      wakeLock.addEventListener('release', () => {
        wakeLockRef.current = null
        setWakeLockEnabled(false)
      })
    } catch {
      setWakeLockEnabled(false)
    }
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
    } catch {
      // ignore
    }
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
        // Persist current session so we auto-resume after reload.
        const session = presenceStateRef.current
        if (session.roomId) {
          writeResumeSession({
            roomId: session.roomId,
            title: session.title,
            cameraId: selectedCameraId,
            savedAt: Date.now(),
          })
        }
        // Give the message a tick to flush, then reload the page.
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

      if (previewRef.current) {
        previewRef.current.srcObject = localStream
      }

      presenceStateRef.current = {
        roomId: desiredRoomId,
        title: desiredTitle,
        startedAt: Date.now(),
      }
      if (desiredTitle !== streamTitle) setStreamTitle(desiredTitle)

      // Persist session so a remote-triggered refresh can auto-resume.
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

        // Admin push-to-talk: admin calls broadcaster with their mic stream.
        peer.on('call', (incomingCall) => {
          if (incomingCall.metadata?.kind !== 'admin-ptt') {
            try { incomingCall.close() } catch { /* noop */ }
            return
          }
          incomingCall.answer() // we don't send media back
          incomingCall.on('stream', (remoteStream) => {
            const el = adminAudioRef.current
            if (!el) return
            el.srcObject = remoteStream
            el.muted = false
            el.play().catch(() => {})
            setAdminTalking(true)
          })
          const stopTalking = () => {
            const el = adminAudioRef.current
            if (el) el.srcObject = null
            setAdminTalking(false)
          }
          incomingCall.on('close', stopTalking)
          incomingCall.on('error', stopTalking)
        })

        peer.on('disconnected', () => {
          try { peer.reconnect() } catch { /* peer destroyed */ }
        })

        peer.on('error', (peerError) => {
          // After a refresh, the PeerJS broker may still hold the previous
          // ID for a few seconds. Retry a few times before failing.
          if (peerError?.type === 'unavailable-id' && attempt < 6) {
            try { peer.destroy() } catch { /* noop */ }
            setTimeout(() => createPeer(attempt + 1), 2000)
            return
          }

          // Non-fatal errors — keep the stream alive.
          // `peer-unavailable` fires when our outbound connect to the admin
          // presence peer fails because no admin dashboard is open yet.
          // `network`/`server-error`/`disconnected` are signaling blips that
          // PeerJS handles via its own reconnect.
          const nonFatal = new Set([
            'peer-unavailable',
            'network',
            'server-error',
            'disconnected',
            'socket-error',
            'socket-closed',
          ])
          if (nonFatal.has(peerError?.type)) {
            if (peerError?.type === 'peer-unavailable') {
              // Admin dashboard isn't up yet — schedule another presence
              // attempt so we appear once they open it.
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
    streamTitle,
    selectedCameraId,
    refreshCameras,
    requestWakeLock,
    connectAdminPresence,
    closeAdminPresence,
    sendPresence,
  ])

  useEffect(() => {
    startBroadcastRef.current = startBroadcast
  }, [startBroadcast])

  const stopBroadcast = () => {
    // Tell viewers cleanly that the stream ended, then admin, then tear down.
    viewerConnsRef.current.forEach((conn) => {
      if (conn.open) {
        try { conn.send({ type: 'bye', reason: 'broadcaster-stopped' }) } catch { /* noop */ }
      }
    })

    if (adminConnRef.current?.open) {
      try {
        adminConnRef.current.send({
          type: 'bye',
          roomId: presenceStateRef.current.roomId,
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
    if (previewRef.current) {
      previewRef.current.srcObject = null
    }
    activeCallsRef.current.clear()
    viewerConnsRef.current.clear()
    presenceStateRef.current = { roomId: '', title: '', startedAt: 0 }
    clearResumeSession()
    setAdminTalking(false)
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
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    setTimeout(() => setCopyState('idle'), 1500)
  }

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refreshCameras()
    }, 0)

    // Auto-resume after a remote admin-triggered refresh.
    const resume = readResumeSession()
    if (resume && resume.roomId && !autoResumeAttemptedRef.current) {
      autoResumeAttemptedRef.current = true
      // Wait briefly for camera permission state and devices to settle.
      window.setTimeout(() => {
        startBroadcastRef.current({
          roomId: resume.roomId,
          title: resume.title || '',
          cameraId: resume.cameraId || '',
        })
      }, 600)
    }

    const onDeviceChange = () => {
      void refreshCameras()
    }
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

      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
      releaseWakeLock()
    }
  }, [refreshCameras, releaseWakeLock, requestWakeLock, closeAdminPresence])

  const hasRealLabels = cameras.some(
    (c) => c.label && !/^Camera \d+$/.test(c.label)
  )

  return (
    <section className="card">
      <h1>Start A Live Camera + Mic Stream</h1>
      <p className="subtext">
        Go live from this page and share one URL. Anyone opening that URL can
        watch video and hear your microphone audio.
      </p>

      <div className="cameraControls">
        <label htmlFor="titleInput">Stream Name (optional)</label>
        <input
          id="titleInput"
          type="text"
          className="textInput"
          placeholder="e.g. Front door camera"
          value={streamTitle}
          onChange={(event) => setStreamTitle(event.target.value)}
          disabled={status === 'live' || status === 'starting'}
          maxLength={60}
        />
      </div>

      <div className="cameraControls">
        <label htmlFor="cameraSelect">Camera Source</label>
        <div className="cameraRow">
          <select
            id="cameraSelect"
            value={selectedCameraId}
            onChange={(event) => setSelectedCameraId(event.target.value)}
            disabled={status === 'starting' || status === 'live' || cameras.length === 0}
          >
            {cameras.length === 0 && <option value="">No camera detected</option>}
            {cameras.map((camera) => (
              <option key={camera.deviceId} value={camera.deviceId}>
                {camera.label}
                {camera.isUsb ? ' • USB' : camera.isBuiltIn ? ' • Built-in' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="secondary detectBtn" onClick={unlockLabels}>
            Detect Cameras
          </button>
        </div>
        <p className="cameraHint">
          {cameras.length === 0
            ? 'No camera detected. On Raspberry Pi, plug in the USB webcam, then click Detect Cameras.'
            : hasRealLabels
            ? 'USB cams (including Raspberry Pi/Linux UVC devices) are auto-labeled.'
            : 'Click Detect Cameras and approve permission to reveal device names.'}
        </p>
      </div>

      <video ref={previewRef} autoPlay playsInline muted className="video" />
      <audio ref={adminAudioRef} autoPlay playsInline />

      {adminTalking && (
        <p className="adminTalkingBanner">🔊 Admin is talking to you</p>
      )}

      <div className="actions">
        <button
          type="button"
          onClick={() => startBroadcast()}
          disabled={status === 'starting' || status === 'live'}
        >
          {status === 'starting' ? 'Starting...' : 'Go Live'}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={stopBroadcast}
          disabled={status !== 'live' && status !== 'starting'}
        >
          Stop
        </button>
      </div>

      {shareUrl && (
        <div className="shareBox">
          <p className="status">
            Live now • {viewerCount} {viewerCount === 1 ? 'viewer' : 'viewers'}
            {resolution ? ` • ${resolution}` : ''}
          </p>
          <div className="shareRow">
            <a href={shareUrl} target="_blank" rel="noreferrer" className="shareLink">
              {shareUrl}
            </a>
            <button type="button" className="copyBtn" onClick={copyShareUrl}>
              {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {status === 'live' && (
        <p className="status subtle">
          Device awake mode: {wakeLockEnabled ? 'On' : 'Not available in this browser'}
        </p>
      )}
    </section>
  )
}

function ViewerPage() {
  const { roomId = '' } = useParams()
  const videoRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const streamTimerRef = useRef(null)
  const attemptRef = useRef(0)
  const [status, setStatus] = useState('connecting')
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange)
    }
  }, [])

  const toggleFullscreen = async () => {
    const el = videoRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else if (el.requestFullscreen) {
        await el.requestFullscreen()
      } else if (el.webkitEnterFullscreen) {
        // iOS Safari: video element only
        el.webkitEnterFullscreen()
      }
    } catch {
      // ignore — user denied or unsupported
    }
  }

  useEffect(() => {
    let activePeer = null
    let activeConn = null
    let activeCall = null
    let gotStream = false
    let cancelled = false
    let ended = false

    const clearTimers = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current)
        streamTimerRef.current = null
      }
    }

    const stopMediaPlayback = () => {
      if (!videoRef.current?.srcObject) return
      const stream = videoRef.current.srcObject
      stream.getTracks().forEach((track) => track.stop())
      videoRef.current.srcObject = null
    }

    const cleanupPeerOnly = () => {
      if (activeCall) {
        activeCall.close()
        activeCall = null
      }
      if (activeConn) {
        activeConn.close()
        activeConn = null
      }
      if (activePeer) {
        activePeer.destroy()
        activePeer = null
      }
    }

    const markEnded = () => {
      ended = true
      cancelled = true
      clearTimers()
      cleanupPeerOnly()
      stopMediaPlayback()
      setStatus('ended')
      setError('')
    }

    const scheduleReconnect = (message) => {
      if (cancelled || ended) return

      clearTimers()
      cleanupPeerOnly()

      if (!navigator.onLine) {
        setStatus('offline')
        setError('Network is offline. Waiting for connection...')
        return
      }

      attemptRef.current += 1
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(attemptRef.current - 1, 4))
      setStatus('reconnecting')
      setError(message)

      reconnectTimerRef.current = window.setTimeout(() => {
        connect()
      }, delayMs)
    }

    const connect = () => {
      if (cancelled || ended) return

      clearTimers()
      cleanupPeerOnly()
      gotStream = false

      if (!navigator.onLine) {
        setStatus('offline')
        setError('Network is offline. Waiting for connection...')
        return
      }

      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting')
      setError('')

      const peer = new Peer({ debug: 0 })
      activePeer = peer

      peer.on('open', () => {
        if (cancelled || ended) return

        const conn = peer.connect(roomId, { reliable: true })
        activeConn = conn

        conn.on('open', () => {
          if (!cancelled && !ended) setStatus('waiting')
        })

        conn.on('data', (data) => {
          if (data && typeof data === 'object' && data.type === 'bye') {
            markEnded()
          }
        })

        conn.on('close', () => {
          if (!gotStream) {
            scheduleReconnect('Broadcaster not reachable. Retrying...')
          }
        })

        conn.on('error', () => {
          scheduleReconnect('Could not connect to this stream URL. Retrying...')
        })
      })

      peer.on('call', (call) => {
        activeCall = call
        call.answer()

        call.on('stream', (remoteStream) => {
          gotStream = true
          attemptRef.current = 0
          clearTimers()
          setError('')
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream
            videoRef.current.play().catch(() => {})
            setStatus('live')
          }
        })

        call.on('close', () => {
          scheduleReconnect('Stream disconnected. Reconnecting...')
        })

        call.on('error', () => {
          scheduleReconnect('Stream interrupted. Reconnecting...')
        })
      })

      peer.on('disconnected', () => {
        scheduleReconnect('Connection lost. Reconnecting...')
      })

      peer.on('close', () => {
        if (!cancelled && !ended) scheduleReconnect('Peer closed. Reconnecting...')
      })

      peer.on('error', (peerError) => {
        if (peerError.type === 'peer-unavailable') {
          // Broadcaster may be refreshing (admin-triggered or otherwise).
          // Keep retrying — only an explicit "bye" message ends the stream.
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
      cleanupPeerOnly()
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
      cleanupPeerOnly()
      stopMediaPlayback()
    }
  }, [roomId])

  return (
    <main className="page">
      <section className="card viewerCard">
        <h1>Watching Stream: {roomId}</h1>
        <p className="subtext">
          If audio does not auto-play in your browser, click inside the video to
          start playback.
        </p>

        <video ref={videoRef} autoPlay playsInline controls className="video" />

        {status === 'ended' ? (
          <div className="endedBanner">
            <p className="endedTitle">Stream has ended</p>
            <p className="endedBody">
              The broadcaster has stopped this stream. Refresh this page if it
              comes back online.
            </p>
          </div>
        ) : (
          <p className="status">
            {status === 'connecting' && 'Connecting...'}
            {status === 'waiting' && 'Connected. Waiting for broadcaster video...'}
            {status === 'live' && 'Live stream active'}
            {status === 'reconnecting' && 'Reconnecting...'}
            {status === 'offline' && 'Offline. Waiting for internet...'}
            {status === 'error' && 'Connection error'}
          </p>
        )}

        {error && status !== 'ended' && <p className="error">{error}</p>}

        <div className="viewerActions">
          <button type="button" onClick={toggleFullscreen}>
            {isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          </button>
        </div>
      </section>
    </main>
  )
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

function AdminDashboard({ onSignOut }) {
  const peerRef = useRef(null)
  const streamsRef = useRef(new Map())
  const connsRef = useRef(new Map()) // roomId -> DataConnection (broadcaster presence)
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
    const session = pttRef.current
    if (session.stream) {
      session.stream.getTracks().forEach((t) => t.stop())
    }
    if (session.call) {
      try { session.call.close() } catch { /* noop */ }
    }
    pttRef.current = { peerId: null, call: null, stream: null }
    setPttActiveRoom('')
    setPttSpeaking(false)
  }, [])

  const setTalking = useCallback((on) => {
    const stream = pttRef.current.stream
    if (!stream) return
    stream.getAudioTracks().forEach((track) => { track.enabled = on })
    setPttSpeaking(on)
  }, [])

  const startPttSession = useCallback(async (room) => {
    setPttError('')
    const peer = peerRef.current
    if (!peer || peer.destroyed) {
      setPttError('Admin signaling not ready.')
      return false
    }

    // If switching streams, tear down the previous session.
    if (pttRef.current.peerId && pttRef.current.peerId !== room.roomId) {
      endPttSession()
    }
    if (pttRef.current.peerId === room.roomId && pttRef.current.call) {
      return true
    }

    let micStream
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
    } catch {
      setPttError('Microphone permission is required for push-to-talk.')
      return false
    }

    micStream.getAudioTracks().forEach((track) => { track.enabled = false })

    const call = peer.call(room.roomId, micStream, { metadata: { kind: 'admin-ptt' } })
    if (!call) {
      micStream.getTracks().forEach((t) => t.stop())
      setPttError('Could not place admin call to this stream.')
      return false
    }

    pttRef.current = { peerId: room.roomId, call, stream: micStream }
    setPttActiveRoom(room.roomId)

    const stop = () => {
      if (pttRef.current.call === call) endPttSession()
    }
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
    try {
      conn.send({ type: 'admin-refresh' })
    } catch {
      setAdminError('Failed to send refresh command.')
    }
  }, [])

  const handlePttDown = useCallback(async (room) => {
    const ok = pttRef.current.peerId === room.roomId
      ? true
      : await startPttSession(room)
    if (ok) setTalking(true)
  }, [startPttSession, setTalking])

  const handlePttUp = useCallback(() => {
    setTalking(false)
  }, [setTalking])

  useEffect(() => {
    const peer = new Peer(ADMIN_PEER_ID, { debug: 0 })
    peerRef.current = peer

    peer.on('open', () => {
      setAdminStatus('listening')
    })

    peer.on('connection', (conn) => {
      // Each broadcaster opens a presence conn; track liveness via heartbeats.
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
        setAdminError(
          'Another admin dashboard is already running for this app. Close it and reload.'
        )
        return
      }
      if (err?.type === 'network' || err?.type === 'server-error') {
        setAdminStatus('reconnecting')
        setAdminError('Signaling connection issue. Will retry automatically.')
        return
      }
      setAdminStatus('error')
      setAdminError(err?.message || 'Admin connection failed.')
    })

    peer.on('disconnected', () => {
      try { peer.reconnect() } catch { /* noop */ }
    })

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
      if (sweeperRef.current) {
        clearInterval(sweeperRef.current)
        sweeperRef.current = null
      }
      endPttSession()
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }
      streamsMap.clear()
      connsMap.clear()
    }
  }, [publish, endPttSession])

  return (
    <main className="page adminPage">
      <section className="card adminCard">
        <div className="adminHeader">
          <div>
            <h1>Admin Dashboard</h1>
            <p className="status subtle">
              {adminStatus === 'connecting' && 'Connecting to presence channel...'}
              {adminStatus === 'listening' && `${streams.length} live stream${streams.length === 1 ? '' : 's'}`}
              {adminStatus === 'reconnecting' && 'Reconnecting to signaling...'}
              {adminStatus === 'conflict' && 'Dashboard conflict'}
              {adminStatus === 'error' && 'Dashboard error'}
            </p>
          </div>
          <button type="button" className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        {adminError && <p className="error">{adminError}</p>}
        {pttError && <p className="error">{pttError}</p>}

        {streams.length === 0 && adminStatus === 'listening' && (
          <p className="emptyState">
            No active streams right now. Streams will appear here the moment a
            broadcaster goes live.
          </p>
        )}

        <div className="streamGrid">
          {streams.map((stream) => {
            const watchUrl = `/watch/${stream.roomId}`
            const isPttActive = pttActiveRoom === stream.roomId
            return (
              <div key={stream.roomId} className="streamTile">
                <a
                  href={watchUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="streamThumbLink"
                >
                  <div className="streamThumb">
                    <span className="liveBadge">
                      <span className="liveDot" /> LIVE
                    </span>
                    <span className="viewerBadge">
                      👁 {stream.viewerCount}
                    </span>
                  </div>
                </a>
                <div className="streamMeta">
                  <p className="streamTitle">
                    {stream.title || `Stream ${stream.roomId}`}
                  </p>
                  <p className="streamSub">
                    {stream.roomId} • {formatDuration(now - stream.startedAt)}
                  </p>
                  <div className="streamActions">
                    <a
                      href={watchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="tileBtn primary"
                    >
                      Open
                    </a>
                    <button
                      type="button"
                      className="tileBtn"
                      onClick={() => handleRefresh(stream)}
                      title="Reload the broadcaster page and auto-resume this stream"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      className={`tileBtn ptt ${isPttActive && pttSpeaking ? 'speaking' : ''}`}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        handlePttDown(stream)
                      }}
                      onPointerUp={handlePttUp}
                      onPointerLeave={handlePttUp}
                      onPointerCancel={handlePttUp}
                      title="Hold to talk to this broadcaster"
                    >
                      {isPttActive && pttSpeaking ? '🎤 Talking' : '🎤 Hold to Talk'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function AdminPage() {
  const navigate = useNavigate()
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem('hawk-admin-unlocked') === '1'
    } catch {
      return false
    }
  })
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')

  const submitPin = (event) => {
    event.preventDefault()
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
      <main className="page">
        <section className="card pinCard">
          <h1>Admin Access</h1>
          <p className="subtext">Enter the admin PIN to continue.</p>
          <form onSubmit={submitPin} className="pinForm">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="textInput"
              placeholder="PIN"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              autoFocus
            />
            <button type="submit">Unlock</button>
          </form>
          {pinError && <p className="error">{pinError}</p>}
          <Link to="/" className="homeLink">
            Back to broadcaster
          </Link>
        </section>
      </main>
    )
  }

  return <AdminDashboard onSignOut={signOut} />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/watch/:roomId" element={<ViewerPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
