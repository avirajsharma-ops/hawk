import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router-dom'
import Peer from 'peerjs'
import './App.css'

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
  // Linux/Raspberry Pi often exposes only "Camera" or empty labels for UVC
  // devices. If there's exactly one video device and it isn't built-in,
  // treat it as USB so users see a sensible label.
  const videoCount = allDevices.filter((d) => d.kind === 'videoinput').length
  if (videoCount === 1 && device.label) {
    return { isUsb: true, isBuiltIn: false }
  }
  return { isUsb: false, isBuiltIn: false }
}

// Try a sequence of constraints until one succeeds. Pi/UVC cameras frequently
// reject "exact" resolution requests, so we fall back progressively.
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

// Boost outgoing video bitrate on the underlying RTCPeerConnection.
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

function BroadcasterPage() {
  const previewRef = useRef(null)
  const peerRef = useRef(null)
  const streamRef = useRef(null)
  const wakeLockRef = useRef(null)
  const statusRef = useRef('idle')
  const activeCallsRef = useRef(new Set())
  const [status, setStatus] = useState('idle')
  const [roomId, setRoomId] = useState('')
  const [error, setError] = useState('')
  const [cameras, setCameras] = useState([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [wakeLockEnabled, setWakeLockEnabled] = useState(false)
  const [resolution, setResolution] = useState('')
  const [viewerCount, setViewerCount] = useState(0)
  const [copyState, setCopyState] = useState('idle')

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
      // Prefer USB cameras (Pi use case) when present.
      const usb = cameraDevices.find((c) => c.isUsb)
      return usb?.deviceId || cameraDevices[0]?.deviceId || ''
    })
  }, [])

  // On Raspberry Pi/Chromium, enumerateDevices returns empty labels until the
  // user has granted media access at least once. Briefly grab the camera to
  // unlock real device names.
  const unlockLabels = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      probe.getTracks().forEach((t) => t.stop())
    } catch {
      // permission denied or no device; still try to enumerate
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

  const startBroadcast = async () => {
    if (status === 'starting' || status === 'live') return

    setError('')
    setStatus('starting')

    try {
      const localStream = await acquireStream(selectedCameraId)
      streamRef.current = localStream

      // Permission granted — labels are now available.
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
      const peer = new Peer(nextRoomId, { debug: 0 })
      peerRef.current = peer

      peer.on('open', () => {
        setRoomId(nextRoomId)
        setStatus('live')
        requestWakeLock()
      })

      peer.on('connection', (conn) => {
        conn.on('open', () => {
          const call = peer.call(conn.peer, localStream)
          if (!call) return
          activeCallsRef.current.add(call)
          setViewerCount(activeCallsRef.current.size)

          const tune = () => tuneSenderBitrate(call)
          if (call.peerConnection) {
            call.peerConnection.addEventListener('connectionstatechange', () => {
              if (call.peerConnection.connectionState === 'connected') tune()
            })
            setTimeout(tune, 1500)
          }

          const drop = () => {
            activeCallsRef.current.delete(call)
            setViewerCount(activeCallsRef.current.size)
          }
          call.on('close', drop)
          call.on('error', drop)
        })
      })

      peer.on('disconnected', () => {
        // PeerJS will try to reconnect to its signaling server automatically.
        try { peer.reconnect() } catch { /* peer already destroyed */ }
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
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (previewRef.current) {
      previewRef.current.srcObject = null
    }
    activeCallsRef.current.clear()
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
  }, [refreshCameras, releaseWakeLock, requestWakeLock])

  const hasRealLabels = cameras.some(
    (c) => c.label && !/^Camera \d+$/.test(c.label)
  )

  return (
    <main className="page">
      <section className="card">
        <h1>Start A Live Camera + Mic Stream</h1>
        <p className="subtext">
          Go live from this page and share one URL. Anyone opening that URL can
          watch video and hear your microphone audio.
        </p>

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
    </main>
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

  useEffect(() => {
    let activePeer = null
    let activeConn = null
    let activeCall = null
    let gotStream = false
    let cancelled = false

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

    const scheduleReconnect = (message) => {
      if (cancelled) return

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
      if (cancelled) return

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
        if (cancelled) return

        const conn = peer.connect(roomId, { reliable: true })
        activeConn = conn

        conn.on('open', () => {
          if (!cancelled) setStatus('waiting')
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
        if (!cancelled) scheduleReconnect('Peer closed. Reconnecting...')
      })

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
      setError('Network restored. Reconnecting...')
      setStatus('reconnecting')
      attemptRef.current = 0
      connect()
    }

    const onOffline = () => {
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

        <p className="status">
          {status === 'connecting' && 'Connecting...'}
          {status === 'waiting' && 'Connected. Waiting for broadcaster video...'}
          {status === 'live' && 'Live stream active'}
          {status === 'reconnecting' && 'Reconnecting...'}
          {status === 'offline' && 'Offline. Waiting for internet...'}
          {status === 'error' && 'Connection error'}
        </p>

        {error && <p className="error">{error}</p>}

        <Link to="/" className="homeLink">
          Start your own stream
        </Link>
      </section>
    </main>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<BroadcasterPage />} />
        <Route path="/watch/:roomId" element={<ViewerPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
