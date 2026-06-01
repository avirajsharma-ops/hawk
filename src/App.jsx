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
const ADMIN_RETRY_MS = 10000

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
  const presenceStateRef = useRef({ roomId: '', title: '', startedAt: 0 })
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
    conn.on('close', scheduleRetry)
    conn.on('error', scheduleRetry)
  }, [closeAdminPresence, sendPresence])

  useEffect(() => {
    connectAdminPresenceRef.current = connectAdminPresence
  }, [connectAdminPresence])

  const startBroadcast = async () => {
    if (status === 'starting' || status === 'live') return

    setError('')
    setStatus('starting')

    try {
      const localStream = await acquireStream(selectedCameraId)
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

      const nextRoomId = generateRoomId()
      presenceStateRef.current = {
        roomId: nextRoomId,
        title: streamTitle.trim(),
        startedAt: Date.now(),
      }

      const peer = new Peer(nextRoomId, { debug: 0 })
      peerRef.current = peer

      peer.on('open', () => {
        setRoomId(nextRoomId)
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

      peer.on('disconnected', () => {
        try { peer.reconnect() } catch { /* peer destroyed */ }
      })

      peer.on('error', (peerError) => {
        const msg = peerError?.message || 'Failed to start broadcast'
        if (peerError?.type === 'network' || peerError?.type === 'server-error') {
          setError(`${msg} — retrying signaling...`)
          return
        }
        setError(msg)
        setStatus('idle')
      })
    } catch {
      setError('Camera/microphone permission is required to go live.')
      setStatus('idle')
    }
  }

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

      <div className="actions">
        <button
          type="button"
          onClick={startBroadcast}
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
  const everHadStreamRef = useRef(false)
  const [status, setStatus] = useState('connecting')
  const [error, setError] = useState('')

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
          everHadStreamRef.current = true
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
          // If we already played the stream and the broadcaster vanishes,
          // treat it as ended rather than retrying forever.
          if (everHadStreamRef.current) {
            markEnded()
            return
          }
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

        <Link to="/" className="homeLink">
          Start your own stream
        </Link>
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
  const sweeperRef = useRef(null)
  const [streams, setStreams] = useState([])
  const [adminStatus, setAdminStatus] = useState('connecting')
  const [adminError, setAdminError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const publish = useCallback(() => {
    setStreams(Array.from(streamsRef.current.values()).sort((a, b) => b.startedAt - a.startedAt))
  }, [])

  useEffect(() => {
    const peer = new Peer(ADMIN_PEER_ID, { debug: 0 })
    peerRef.current = peer

    peer.on('open', () => {
      setAdminStatus('listening')
    })

    peer.on('connection', (conn) => {
      // Each broadcaster opens a presence conn; track liveness via heartbeats.
      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return
        if (data.type === 'presence' && data.roomId) {
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
          publish()
        }
      })

      conn.on('close', () => {
        // Remove any stream entries tied to this broadcaster peer.
        let changed = false
        streamsRef.current.forEach((entry, key) => {
          if (entry.peerId === conn.peer) {
            streamsRef.current.delete(key)
            changed = true
          }
        })
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

    // Sweep stale entries (no heartbeat in window).
    sweeperRef.current = setInterval(() => {
      const now = Date.now()
      let changed = false
      streamsRef.current.forEach((entry, key) => {
        if (now - entry.lastSeen > PRESENCE_TIMEOUT_MS) {
          streamsRef.current.delete(key)
          changed = true
        }
      })
      if (changed) publish()
      setNow(Date.now())
    }, 2000)

    const streamsMap = streamsRef.current
    return () => {
      if (sweeperRef.current) {
        clearInterval(sweeperRef.current)
        sweeperRef.current = null
      }
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }
      streamsMap.clear()
    }
  }, [publish])

  return (
    <main className="page adminPage">
      <section className="card adminCard">
        <div className="adminHeader">
          <h1>Admin Dashboard</h1>
          <button type="button" className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        <p className="status">
          {adminStatus === 'connecting' && 'Connecting to presence channel...'}
          {adminStatus === 'listening' && `Live streams: ${streams.length}`}
          {adminStatus === 'reconnecting' && 'Reconnecting to signaling...'}
          {adminStatus === 'conflict' && 'Dashboard conflict'}
          {adminStatus === 'error' && 'Dashboard error'}
        </p>

        {adminError && <p className="error">{adminError}</p>}

        {streams.length === 0 && adminStatus === 'listening' && (
          <p className="cameraHint">
            No active streams right now. Streams appear here as soon as a
            broadcaster goes live.
          </p>
        )}

        <div className="streamGrid">
          {streams.map((stream) => {
            const watchUrl = `/watch/${stream.roomId}`
            return (
              <Link
                key={stream.roomId}
                to={watchUrl}
                className="streamTile"
                target="_blank"
                rel="noreferrer"
              >
                <div className="streamThumb">
                  <span className="liveDot" />
                  <span className="liveLabel">LIVE</span>
                </div>
                <div className="streamMeta">
                  <p className="streamTitle">
                    {stream.title || `Stream ${stream.roomId}`}
                  </p>
                  <p className="streamSub">
                    {stream.roomId} • {formatDuration(now - stream.startedAt)} •{' '}
                    {stream.viewerCount} {stream.viewerCount === 1 ? 'viewer' : 'viewers'}
                  </p>
                </div>
              </Link>
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
