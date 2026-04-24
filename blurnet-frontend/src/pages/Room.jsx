/**
 * Refactored Room Component - Google Meet Style
 * 
 * KEY CHANGES:
 * 1. NO getUserMedia() on page load
 * 2. Join meeting WITHOUT media permissions (receive-only mode)
 * 3. Request permissions only on-demand (user clicks "Enable Mic/Cam")
 * 4. Create RTCPeerConnection without local tracks initially
 * 5. Add tracks dynamically via addTrack/replaceTrack
 * 
 * USER FLOW:
 * - Join room → Can see peers immediately (no permission prompt)
 * - Click "Enable Camera" → Request camera permission
 * - Click "Enable Mic" → Request mic permission
 * - Click "Share Screen" → Request screen permission
 * 
 * If permission denied:
 * - Show error toast
 * - User can still see/hear others
 * - Chat remains available
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Mic, MicOff, Video, VideoOff, MonitorUp, PhoneMissed, MessageSquare, ShieldAlert, UserRound } from 'lucide-react';
import { RoomSocket } from '../utils/RoomSocket';
import { 
  createPeerConnection, 
  addFullMedia, 
  replaceTrackOnSender 
} from '../utils/webrtcMesh';
import VideoTile from '../components/VideoTile';
import { WebSocketClient } from '../utils/WebSocketClient';
import { AudioProcessor } from '../utils/AudioProcessor';
import { useMediaPermissions } from '../hooks/useMediaPermissions';
import { VideoProcessor } from '../utils/VideoProcessor';
import { useAuth } from '../context/AuthContext';

function shortId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const SIGNAL_BASE = useMemo(
    () => import.meta.env.VITE_SIGNALING_WS_BASE || 'ws://localhost:8000/ws/room',
    [],
  );
  const MODERATION_WS = useMemo(
    () => import.meta.env.VITE_MODERATION_WS || 'ws://localhost:8000/ws/moderate',
    [],
  );

  // ============================================================================
  // PERMISSION MANAGEMENT (lazy, on-demand)
  // ============================================================================
  const mediaPermissions = useMediaPermissions();
  const [localStream, setLocalStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState('info'); // info | error | success

  const showToast = useCallback((message, type = 'info') => {
    setToastMessage(message);
    setToastType(type);
    setTimeout(() => setToastMessage(''), 4000);
  }, []);

  // ============================================================================
  // ROOM & SIGNALING STATE
  // ============================================================================
  const roomSocketRef = useRef(null);
  const [self, setSelf] = useState(null);
  const [peers, setPeers] = useState([]);
  const [connected, setConnected] = useState(false);
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
  const selfRef = useRef(null);
  const pendingPeerIdsRef = useRef(new Set());
  const pendingSignalsRef = useRef(new Map());

  // ============================================================================
  // WEBRTC STATE
  // ============================================================================
  const pcsRef = useRef(new Map()); // peerId -> RTCPeerConnection
  const sendersRef = useRef(new Map()); // peerId -> { audioSender, videoSender }
  const politeRef = useRef(new Map()); // peerId -> boolean (for glare handling)
  const rtcStateRef = useRef(new Map()); // peerId -> { makingOffer, polite }
  const pendingIceRef = useRef(new Map());
  const remoteStreamsRef = useRef(new Map());
  const speakerAnalyzersRef = useRef(new Map());

  // ============================================================================
  // MODERATION & AUDIO & VIDEO
  // ============================================================================
  const moderationWsRef = useRef(null);
  const audioProcRef = useRef(null);
  
  // Pipeline Refs for Sender-Side Security
  const videoProcRef = useRef(null);
  const rawVideoRef = useRef(null);
  const processedCanvasRef = useRef(null);
  const sendLoopRef = useRef(null);
  const rawVideoTrackRef = useRef(null);

  const [aiOn, setAiOn] = useState(true);
  const [audioSanitized, setAudioSanitized] = useState(false);
  const [showUnsafeAlert, setShowUnsafeAlert] = useState(false);
  const unsafeAlertRef = useRef(false);

  // Initialize AI Video Pipeline globally off-screen
  useEffect(() => {
    videoProcRef.current = new VideoProcessor({ width: 640, height: 480 });
    
    rawVideoRef.current = document.createElement('video');
    rawVideoRef.current.muted = true;
    rawVideoRef.current.playsInline = true;
    
    processedCanvasRef.current = document.createElement('canvas');
    processedCanvasRef.current.width = 640;
    processedCanvasRef.current.height = 480;

    return () => {
      videoProcRef.current?.stopRenderLoop?.();
      clearTimeout(sendLoopRef.current);
    };
  }, []);

  // ============================================================================
  // UI STATE
  // ============================================================================
  const [streams, setStreams] = useState({});
  const [peerMediaState, setPeerMediaState] = useState({});
  const [activeSpeakerId, setActiveSpeakerId] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState([]);
  const [chatDraft, setChatDraft] = useState('');
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // Track what the user has enabled (independent of actual stream)
  const [micEnabled, setMicEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  
  const [engineAction, setEngineAction] = useState(null);
  const [isCameraBlocked, setIsCameraBlocked] = useState(false);
  const [riskScore, setRiskScore] = useState(0);

  // ============================================================================
  // SYNCHRONIZED REFS (Must be declared AFTER their corresponding useState)
  // ============================================================================
  const aiOnRef = useRef(aiOn);
  const localStreamRef = useRef(localStream);
  const micEnabledRef = useRef(micEnabled);
  const isCameraBlockedRef = useRef(isCameraBlocked);

  useEffect(() => { 
    aiOnRef.current = aiOn; 
    videoProcRef.current?.setAiState?.(aiOn);
  }, [aiOn]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);
  useEffect(() => { isCameraBlockedRef.current = isCameraBlocked; }, [isCameraBlocked]);

  // ============================================================================
  // EFFECTS: ROOM INITIALIZATION
  // ============================================================================

  // Auto-generate room ID if not provided
  useEffect(() => {
    if (!roomId) navigate(`/room/${shortId()}`, { replace: true });
  }, [roomId, navigate]);



  // Connect to signaling server (NO MEDIA ON LOAD)
  useEffect(() => {
    if (!roomId) return;

    const roomSocket = new RoomSocket({
      baseUrl: SIGNAL_BASE,
      roomId,
      name: user?.name,
      onMessage: handleRoomMessage,
    });
    roomSocketRef.current = roomSocket;

    // Connect to signaling immediately (no media needed)
    (async () => {
      try {
        await roomSocket.connect();
        console.log('[ROOM] Connected to signaling');
        setConnected(true);
      } catch (err) {
        console.error('[ROOM] Signaling connection failed:', err);
        showToast('Failed to join room', 'error');
      }
    })();

    return () => {
      roomSocket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, SIGNAL_BASE]);

  // Connect to moderation WS
  useEffect(() => {
    const ws = new WebSocketClient(MODERATION_WS, (msg) => {
      if (msg?.type === 'audio_result' && msg?.result?.abusive) {
        setAudioSanitized(true);
        // Temporarily mute mic
        if (localStreamRef.current) {
          localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = false));
        }
        setTimeout(() => {
          setAudioSanitized(false);
          if (localStreamRef.current && micEnabledRef.current) {
            localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = true));
          }
        }, 2500);
      }
      if (msg?.type === 'moderation_result') {
        const proc = videoProcRef.current;
        if (proc) {
            proc.notifyFrameReceived();
            proc.setRegions(msg.regions || [], msg.max_score || 0, msg.nsfw_score || 0.0, msg.action || "safe");
            
            // Map the rigorously smoothed hysteresis state directly to UI without flickering
            const isActive = proc.hasActiveBlur();
            if (isActive !== unsafeAlertRef.current) {
                unsafeAlertRef.current = isActive;
                setShowUnsafeAlert(isActive);
            }
            if (msg.action) {
                setEngineAction(msg.action);
            }
            if (msg.riskScore !== undefined) {
                setRiskScore(msg.riskScore);
            }
        }
      }
    });

    ws.connect().catch(e => console.error("WS Connect err", e));
    moderationWsRef.current = ws;
    return () => ws.disconnect();
  }, [MODERATION_WS]);

  // Handle Auto-Enforcement Actions from Engine
  useEffect(() => {
    if (!engineAction) return;
    
    if (engineAction === 'mute') {
       showToast("System muted your microphone due to repeated safety violations.", "error");
       if (micEnabledRef.current && localStreamRef.current) {
           localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = false));
       }
    } else if (engineAction === 'block') {
       showToast("Camera disabled due to high risk or multiple violations.", "error");
       setIsCameraBlocked(true);
       if (localStreamRef.current) {
           localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = false));
       }
    } else if (engineAction === 'remove') {
       showToast("You have been removed from the room for violating safety policies.", "error");
       navigate('/');
    }
  }, [engineAction, navigate, showToast]);

  // Active speaker detection
  useEffect(() => {
    const interval = setInterval(() => {
      let best = { id: null, score: 0.02 };
      speakerAnalyzersRef.current.forEach((v, peerId) => {
        const { analyser, data } = v;
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const n = (data[i] - 128) / 128;
          sum += n * n;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > best.score) best = { id: peerId, score: rms };
      });
      setActiveSpeakerId(best.id);
    }, 250);
    return () => clearInterval(interval);
  }, []);

  // Keep refs in sync with state
  useEffect(() => {
    selfRef.current = self;
  }, [self]);

  // ============================================================================
  // WEBRTC: ROOM MESSAGE HANDLING
  // ============================================================================

  const handleRoomMessage = useCallback(
    async (msg) => {
      const type = msg?.type;
      const data = msg?.data || {};

      if (type === 'room_joined') {
        setSelf(data.self);
        setPeers(data.peers || []);
        const selfId = data.self?.id;
        (data.peers || []).forEach((p) => {
          politeRef.current.set(p.id, selfId > p.id);
        });
        // Create PCs for existing peers (receive-only, no tracks yet)
        for (const p of data.peers || []) {
          ensurePeer(p.id);
        }
        setHasJoinedRoom(true);
        return;
      }

      if (type === 'peer_joined') {
        const p = data.peer;
        setPeers((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
        const curSelf = selfRef.current;
        if (curSelf?.id) politeRef.current.set(p.id, curSelf.id > p.id);
        ensurePeer(p.id);
        return;
      }

      if (type === 'peer_left') {
        const pid = data.peerId;
        setPeers((prev) => prev.filter((p) => p.id !== pid));
        setStreams((prev) => {
          const copy = { ...prev };
          delete copy[pid];
          return copy;
        });
        closePeer(pid);
        return;
      }

      if (type === 'signal') {
        const from = data.from;
        const payload = data.payload;
        handleSignal(from, payload);
        return;
      }

      if (type === 'chat') {
        setChat((prev) => [...prev, { from: data.from, text: data.text, ts: Date.now() }]);
        return;
      }

      if (type === 'media_state') {
        setPeerMediaState((prev) => ({
          ...prev,
          [data.from]: { ...prev[data.from], ...data.state }
        }));
        return;
      }
    },
    [],
  );

  // ============================================================================
  // WEBRTC: PEER CONNECTION MANAGEMENT
  // ============================================================================

  const ensurePeer = useCallback(
    (peerId) => {
      if (pcsRef.current.has(peerId)) return;

      const polite = politeRef.current.get(peerId) ?? true;

      // Create RECEIVE-ONLY PC (no tracks added yet)
      const pc = createPeerConnection({
        onIceCandidate: (candidate) => {
          console.log(`[RTC] Sending ICE candidate to ${peerId}`);
          roomSocketRef.current?.send('signal', { to: peerId, payload: { candidate } });
        },
        onTrack: (e) => {
          const track = e.track;
          console.log(`[RTC] ontrack fired for ${peerId}, kind: ${track.kind}`);
          
          // Accumulate tracks gracefully to accommodate standalone split stream topologies natively
          setStreams((prev) => {
            const newStream = new MediaStream();
            const existingStream = prev[peerId];
            if (existingStream) {
              existingStream.getTracks().forEach(t => newStream.addTrack(t));
            }
            if (!newStream.getTracks().includes(track)) {
              newStream.addTrack(track);
            }
            remoteStreamsRef.current.set(peerId, newStream);
            
            // Setup speaker analyzer explicitly if an audio track arrives
            if (track.kind === 'audio' && !speakerAnalyzersRef.current.has(peerId)) {
              const ctx = new (window.AudioContext || window.webkitAudioContext)();
              const source = ctx.createMediaStreamSource(new MediaStream([track]));
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 512;
              const dataArr = new Uint8Array(analyser.fftSize);
              source.connect(analyser);
              speakerAnalyzersRef.current.set(peerId, { ctx, analyser, data: dataArr });
            }

            return { ...prev, [peerId]: newStream };
          });
        },
      });

      pc.oniceconnectionstatechange = () => {
        console.log("ICE STATE:", pc.iceConnectionState);
      };

      pc.onconnectionstatechange = () => {
        console.log("CONNECTION STATE:", pc.connectionState);
      };

      // Failsafe for stuck state logging
      setTimeout(() => {
        if (pc.iceConnectionState === 'checking') {
          console.warn(`[RTC] WARNING: ICE stuck at 'checking' for ${peerId}. Potential STRICT firewall/symmetric NAT without valid TURN.`);
        }
      }, 10000);

      rtcStateRef.current.set(peerId, { makingOffer: false, polite });

      if (localStream) {
        localStream.getTracks().forEach(track => {
          pc.addTrack(track, localStream);
        });
      }

      // Perfect negotiation
      pc.onnegotiationneeded = async () => {
        const state = rtcStateRef.current.get(peerId);
        if (!state) return;
        if (state.makingOffer) return;

        try {
          if (!roomSocketRef.current?.isConnected) return;

          state.makingOffer = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          console.log(`[RTC] Sending offer to ${peerId}`);
          roomSocketRef.current?.send('signal', {
            to: peerId,
            payload: { description: pc.localDescription },
          });
        } catch (e) {
          console.warn('[RTC] onnegotiationneeded failed:', e);
        } finally {
          state.makingOffer = false;
        }
      };

      pcsRef.current.set(peerId, pc);
      sendersRef.current.set(peerId, { audioSender: null, videoSender: null });

      console.log(`[RTC] Created receive-only PC for ${peerId}`);
    },
    [],
  );

  const closePeer = useCallback((peerId) => {
    const pc = pcsRef.current.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {}
    }
    pcsRef.current.delete(peerId);
    sendersRef.current.delete(peerId);
    rtcStateRef.current.delete(peerId);
    pendingIceRef.current.delete(peerId);

    const rs = remoteStreamsRef.current.get(peerId);
    if (rs) {
      try {
        rs.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    remoteStreamsRef.current.delete(peerId);

    const ana = speakerAnalyzersRef.current.get(peerId);
    if (ana) {
      try {
        ana.ctx.close();
      } catch {}
    }
    speakerAnalyzersRef.current.delete(peerId);
  }, []);

  const handleSignal = useCallback(
    async (from, payload) => {
      if (!roomSocketRef.current?.isConnected) return;

      await ensurePeer(from);
      const pc = pcsRef.current.get(from);
      if (!pc) {
        // Buffer for later
        if (!pendingSignalsRef.current.has(from)) pendingSignalsRef.current.set(from, []);
        pendingSignalsRef.current.get(from).push(payload);
        return;
      }

      if (payload.description) {
        const description = payload.description;
        const state = rtcStateRef.current.get(from) || {
          makingOffer: false,
          polite: politeRef.current.get(from) ?? true,
        };

        const isOffer = description.type === 'offer';
        const offerCollision = isOffer && (state.makingOffer || pc.signalingState !== 'stable');
        const ignoreOffer = offerCollision && !state.polite;
        if (ignoreOffer) {
          console.log(`[RTC] Ignoring colliding offer from ${from}`);
          return;
        }

        try {
          await pc.setRemoteDescription(description);
        } catch (err) {
          console.error('[RTC] setRemoteDescription error:', err);
          return;
        }

        // Flush buffered ICE
        const queuedIce = pendingIceRef.current.get(from) || [];
        if (queuedIce.length) {
          console.log(`[RTC] Flushing ${queuedIce.length} queued ICE candidates for ${from}`);
          pendingIceRef.current.delete(from);
          for (const c of queuedIce) {
            try {
              await pc.addIceCandidate(c);
            } catch (e) {
              console.warn('[RTC] queued addIceCandidate failed:', e);
            }
          }
        }

        if (isOffer) {
          try {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log(`[RTC] Sending answer to ${from}`);
            roomSocketRef.current?.send('signal', {
              to: from,
              payload: { description: pc.localDescription },
            });
          } catch (err) {
            console.error('[RTC] createAnswer/setLocalDescription error:', err);
          }
        }
      }

      if (payload.candidate) {
        console.log(`[RTC] Received ICE candidate from ${from}`);
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (e) {
          console.warn('[RTC] Delaying ICE candidate addition:', e);
          const list = pendingIceRef.current.get(from) || [];
          list.push(payload.candidate);
          pendingIceRef.current.set(from, list);
        }
      }
    },
    [],
  );

  // ============================================================================
  // PERMISSION MANAGEMENT & TRACK HELPERS
  // ============================================================================

  const renegotiate = useCallback(async (peerId) => {
    const pc = pcsRef.current.get(peerId);
    if (!pc) return;
    try {
      const state = rtcStateRef.current.get(peerId);
      if (state) state.makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      roomSocketRef.current?.send('signal', {
        to: peerId,
        payload: { description: pc.localDescription },
      });
    } catch (e) {
      console.warn('[RTC] FORCE renegotiate failed:', e);
    } finally {
      const state = rtcStateRef.current.get(peerId);
      if (state) state.makingOffer = false;
    }
  }, []);

  const addOrReplaceTrack = useCallback(async (peerId, track, stream) => {
    const pc = pcsRef.current.get(peerId);
    if (!pc) return;

    // Find the transceiver corresponding to this track's kind
    // transceiver.receiver.track ALWAYS exists for a transceiver, so we can use its kind.
    // Also ensuring the transceiver is not stopped.
    let transceiver = pc.getTransceivers().find(t => 
      !t.stopped && (t.receiver?.track?.kind === (track ? track.kind : 'video') || t.sender?.track?.kind === (track ? track.kind : 'video'))
    );
    
    if (transceiver && transceiver.sender) {
      await transceiver.sender.replaceTrack(track);
      
      if (track) {
        if (transceiver.direction === 'recvonly') transceiver.direction = 'sendrecv';
        else if (transceiver.direction === 'inactive') transceiver.direction = 'sendonly';
      } else {
        if (transceiver.direction === 'sendrecv') transceiver.direction = 'recvonly';
        else if (transceiver.direction === 'sendonly') transceiver.direction = 'inactive';
      }

      console.log(`[RTC] Replaced track for peer ${peerId}`);
    } else if (track) {
      pc.addTrack(track, stream);
      console.log(`[RTC] Added ${track.kind} track to PC for peer ${peerId}`);
    }
  }, []);

  // ============================================================================
  // MEDIA CONTROLS (FULLY DYNAMIC LIFECYCLE)
  // ============================================================================

  const toggleMic = useCallback(async () => {
    if (!micEnabled) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        let track = stream.getAudioTracks()[0];
        let outboundStream = stream;
        console.log("Microphone track started");

        if (aiOnRef.current) {
          if (!moderationWsRef.current?.isConnected) {
             await moderationWsRef.current?.connect?.();
          }
          audioProcRef.current = new AudioProcessor((chunk) => {
            moderationWsRef.current?.send?.('audio_chunk', chunk);
          });
          await audioProcRef.current.start(stream);
          
          outboundStream = audioProcRef.current.getProcessedStream();
          track = outboundStream.getAudioTracks()[0];
        }

        const activeVideo = localStream ? localStream.getVideoTracks() : [];
        const finalLocalStream = new MediaStream([...activeVideo, track]);
        setLocalStream(finalLocalStream);

        for (const peerId of pcsRef.current.keys()) {
          await addOrReplaceTrack(peerId, track, finalLocalStream);
        }

        setMicEnabled(true);
        roomSocketRef.current?.send('media_state', { state: { audio: true } });
        showToast('Mic on', 'success');
      } catch (err) {
        console.error('Mic error', err);
        showToast('Mic access denied', 'error');
      }
    } else {
      const audioTracks = localStream?.getAudioTracks() || [];
      audioTracks.forEach((t) => {
        t.stop();
        if (localStream) localStream.removeTrack(t);
        console.log("Microphone track stopped");
      });

      // MUST DO: Clear sender track to unfreeze remote peer without renegotiation
      for (const peerId of pcsRef.current.keys()) {
        const pc = pcsRef.current.get(peerId);
        if (pc) {
          const transceiver = pc.getTransceivers().find(t => 
            t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
          );
          if (transceiver && transceiver.sender) {
            transceiver.sender.replaceTrack(null).catch(e => console.warn('replaceTrack(null) failed', e));
          }
        }
      }

      if (localStream) {
        setLocalStream(new MediaStream(localStream.getTracks()));
      }

      setMicEnabled(false);
      roomSocketRef.current?.send('media_state', { state: { audio: false } });
      showToast('Mic off', 'info');
    }
  }, [micEnabled, localStream, aiOn, addOrReplaceTrack, renegotiate, showToast]);

  const toggleCamera = useCallback(async () => {
    if (isCameraBlockedRef.current) {
      showToast('Camera is blocked due to safety violations.', 'error');
      return;
    }
    
    if (isScreenSharing) {
      showToast('Cannot toggle camera while sharing screen', 'error');
      return;
    }

    if (!cameraEnabled) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const rawTrack = stream.getVideoTracks()[0];
        console.log("Camera track started");

        rawVideoTrackRef.current = rawTrack;

        // Boot up hidden processing layer natively
        rawVideoRef.current.srcObject = new MediaStream([rawTrack]);
        await rawVideoRef.current.play().catch(() => {});
        videoProcRef.current.startRenderLoop(rawVideoRef.current, processedCanvasRef.current);

        // Capture proxy track implicitly
        const processedStream = processedCanvasRef.current.captureStream(30);
        const processedTrack = processedStream.getVideoTracks()[0];

        // Start async interception sending loop safely
        if (aiOnRef.current && moderationWsRef.current && !moderationWsRef.current.isConnected) {
          await moderationWsRef.current.connect();
        }

        if (!sendLoopRef.current) {
          console.log("Processing stream type: webcam");
          const loop = () => {
            const proc = videoProcRef.current;
            if (!proc) return;
            const now = Date.now();
            if (proc.isBackendProcessing) {
              if (now - proc.lastFrameSentAt > 1500) {
                 console.log("Failsafe: Backend lagging >1500ms");
                 proc.triggerFailsafeBlur();
              }
            } else if (aiOnRef.current && moderationWsRef.current?.isConnected) {
              const frame = proc.extractFrame(rawVideoRef.current, 'webcam');
              if (frame) {
                proc.notifyFrameSent();
                moderationWsRef.current.send('video_frame', { 
                  frame, 
                  source_type: 'webcam',
                  user_id: selfRef.current?.id || roomId 
                });
              }
            }
            sendLoopRef.current = setTimeout(loop, 100);
          };
          loop();
        }

        let activeStream = localStream;
        if (activeStream) {
          activeStream.addTrack(processedTrack);
          setLocalStream(new MediaStream(activeStream.getTracks()));
        } else {
          activeStream = new MediaStream([processedTrack]);
          setLocalStream(activeStream);
        }

        // MANDATORY FIX: explicitly map to Send-Receive directly without wrappers
        pcsRef.current.forEach(async (pc, peerId) => {
          await addOrReplaceTrack(peerId, processedTrack, processedStream);
          
          // Ensure audio is preserved natively alongside it inside localStream context explicitly
          const audioTrack = activeStream.getAudioTracks()[0];
          if (audioTrack) {
            await addOrReplaceTrack(peerId, audioTrack, activeStream);
          }
        });

        setCameraEnabled(true);
        roomSocketRef.current?.send('media_state', { state: { video: true } });
        showToast('Camera on', 'success');
      } catch (err) {
        console.error('Camera error', err);
        showToast('Camera access denied', 'error');
      }
    } else {
      // Cleanly stop proxy interception loops
      if (sendLoopRef.current) {
        clearTimeout(sendLoopRef.current);
        sendLoopRef.current = null;
      }
      videoProcRef.current?.stopRenderLoop?.();

      if (rawVideoTrackRef.current) {
        rawVideoTrackRef.current.stop();
        rawVideoTrackRef.current = null;
      }

      // Fix UI getting stuck in 'Unsafe' state after turning camera off
      if (videoProcRef.current) {
         videoProcRef.current.isBackendProcessing = false;
         videoProcRef.current.clearState?.(); // Make sure to call clearState if available
      }
      setShowUnsafeAlert(false);
      unsafeAlertRef.current = false;

      const videoTracks = localStream?.getVideoTracks() || [];
      videoTracks.forEach((t) => {
        t.stop();
        if (localStream) localStream.removeTrack(t);
        console.log("Camera track stopped");
      });

      // MUST DO: Clear sender track to instantly unfreeze remote peer video
      for (const peerId of pcsRef.current.keys()) {
        const pc = pcsRef.current.get(peerId);
        if (pc) {
          const transceiver = pc.getTransceivers().find(t => 
            t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video'
          );
          if (transceiver && transceiver.sender) {
            transceiver.sender.replaceTrack(null).catch(e => console.warn('replaceTrack(null) failed', e));
          }
        }
        renegotiate(peerId);
      }

      if (localStream) {
        setLocalStream(new MediaStream(localStream.getTracks()));
      }

      setCameraEnabled(false);
      roomSocketRef.current?.send('media_state', { state: { video: false } });
      showToast('Camera off', 'info');
    }
  }, [cameraEnabled, localStream, addOrReplaceTrack, renegotiate, showToast]);

  const stopScreenShare = useCallback(async () => {
    if (!isScreenSharing) return;

    setIsScreenSharing(false);

    try {
      if (cameraEnabled) {
        showToast('Restoring camera...', 'info');
        
        // 1. Fetch fresh camera securely
        const freshCameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const rawTrack = freshCameraStream.getVideoTracks()[0];
        
        if (rawVideoTrackRef.current) rawVideoTrackRef.current.stop();
        rawVideoTrackRef.current = rawTrack;

        // 2. Re-wire to the exact same canvas processor natively
        rawVideoRef.current.srcObject = new MediaStream([rawTrack]);
        await rawVideoRef.current.play().catch(() => {});
        videoProcRef.current?.startRenderLoop?.(rawVideoRef.current, processedCanvasRef.current);
        
        const processedStream = processedCanvasRef.current.captureStream(30);
        const proxyTrack = processedStream.getVideoTracks()[0];

        // Ensure we explicitly resume the WEBCAM moderation loop
        if (aiOnRef.current && moderationWsRef.current && !moderationWsRef.current.isConnected) {
          await moderationWsRef.current.connect();
        }
        if (sendLoopRef.current) clearTimeout(sendLoopRef.current);
        
        console.log("Processing stream type: webcam");
        const loop = () => {
          const proc = videoProcRef.current;
          if (!proc) return;
          const now = Date.now();
          if (proc.isBackendProcessing) {
            if (now - proc.lastFrameSentAt > 1500) {
               console.log("Failsafe: Backend lagging >1500ms");
               proc.triggerFailsafeBlur();
            }
          } else if (aiOnRef.current && moderationWsRef.current?.isConnected) {
            const frame = proc.extractFrame(rawVideoRef.current, 'webcam');
            if (frame) {
              proc.notifyFrameSent();
              moderationWsRef.current.send('video_frame', { frame, source_type: 'webcam' });
            }
          }
          sendLoopRef.current = setTimeout(loop, 100);
        };
        loop();

        // 3. Construct proxy securely
        const audioTracks = localStream ? localStream.getAudioTracks() : [];
        const finalStream = new MediaStream([...audioTracks, proxyTrack]);
        setLocalStream(finalStream);

        // 4. Overwrite natively (zero-glare transition utilizing same track logic)
        for (const peerId of pcsRef.current.keys()) {
          await addOrReplaceTrack(peerId, proxyTrack, finalStream);
        }
        roomSocketRef.current?.send('media_state', { state: { video: true } });
        showToast('Screen sharing stopped. Camera restored', 'success');
      } else {
        // Mute safely if camera was meant to be off
        videoProcRef.current?.stopRenderLoop?.();
        for (const peerId of pcsRef.current.keys()) {
          const pc = pcsRef.current.get(peerId);
          if (pc) {
            const transceiver = pc.getTransceivers().find(t => 
              t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video'
            );
            if (transceiver && transceiver.sender) {
              transceiver.sender.replaceTrack(null).catch(e => console.warn('replaceTrack(null) failed', e));
              if (transceiver.direction === 'sendrecv') transceiver.direction = 'recvonly';
              else if (transceiver.direction === 'sendonly') transceiver.direction = 'inactive';
            }
          }
        }
        roomSocketRef.current?.send('media_state', { state: { video: false } });
        
        const audioTracks = localStream ? localStream.getAudioTracks() : [];
        if (audioTracks.length > 0) {
          setLocalStream(new MediaStream(audioTracks));
        } else {
          setLocalStream(null);
        }
        showToast('Screen sharing stopped', 'info');
      }
    } catch (err) {
      console.warn('[RTC] Error restoring camera:', err);
      setCameraEnabled(false);
      roomSocketRef.current?.send('media_state', { state: { video: false } });
    } finally {
      // 5. Clean up dead screen track exclusively after transition is complete!
      if (screenStream) {
        screenStream.getVideoTracks().forEach(t => { t.onended = null; t.stop(); });
        setScreenStream(null);
      }
    }
  }, [isScreenSharing, cameraEnabled, localStream, addOrReplaceTrack, showToast, screenStream]);

  const startScreenShare = useCallback(async () => {
    if (isScreenSharing) return;

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) return;

      // 1. Swap hidden <video> input directly to the screen source
      if (rawVideoTrackRef.current) {
        rawVideoTrackRef.current.stop(); // Turn off camera light
      }
      rawVideoTrackRef.current = screenTrack;
      rawVideoRef.current.srcObject = new MediaStream([screenTrack]);
      await rawVideoRef.current.play().catch(() => {});

      // 2. Ensure VideoProcessor loop is actively masking the new source
      videoProcRef.current?.startRenderLoop?.(rawVideoRef.current, processedCanvasRef.current);
      const processedStream = processedCanvasRef.current.captureStream(30);
      const proxyTrack = processedStream.getVideoTracks()[0];

      // 3. START AI ON SCREEN CONTENT EXPLICITLY
      if (aiOnRef.current && moderationWsRef.current && !moderationWsRef.current.isConnected) {
        await moderationWsRef.current.connect();
      }
      if (sendLoopRef.current) clearTimeout(sendLoopRef.current);
      
      console.log("Processing stream type: screen");
      const loop = () => {
        const proc = videoProcRef.current;
        if (!proc) return;
        const now = Date.now();
        if (proc.isBackendProcessing) {
          if (now - proc.lastFrameSentAt > 1500) {
             console.log("Failsafe: Backend lagging >1500ms");
             proc.triggerFailsafeBlur();
          }
        } else if (aiOnRef.current && moderationWsRef.current?.isConnected) {
          const frame = proc.extractFrame(rawVideoRef.current, 'screen');
          if (frame) {
            proc.notifyFrameSent();
            moderationWsRef.current.send('video_frame', { frame, source_type: 'screen' });
          }
        }
        sendLoopRef.current = setTimeout(loop, 100);
      };
      loop();

      setIsScreenSharing(true);
      screenTrack.onended = () => stopScreenShare(); // Must wrap correctly to decouple event
      setScreenStream(display);

      // 3. Local preview directly observes the canvas output
      const activeAudio = localStream ? localStream.getAudioTracks() : [];
      const newLocal = new MediaStream([...activeAudio, proxyTrack]);
      setLocalStream(newLocal);

      // 4. Either Add or Replace gracefully without WebRTC glare
      for (const peerId of pcsRef.current.keys()) {
         await addOrReplaceTrack(peerId, proxyTrack, newLocal);
      }

      roomSocketRef.current?.send('media_state', { state: { video: true } });
      showToast('Screen sharing started', 'success');
    } catch (err) {
      console.warn('[RTC] Screen share failed:', err);
      if (err.name !== 'NotAllowedError') {
        showToast('Failed to start screen share', 'error');
      }
    }
  }, [isScreenSharing, showToast, addOrReplaceTrack, localStream, stopScreenShare]);

  // ============================================================================
  // CLEANUP & LEAVING
  const leave = useCallback(() => {
    // Close all peer connections
    for (const [_, pc] of pcsRef.current.entries()) {
      try {
        pc.close();
      } catch {}
    }

    // Stop all streams
    try {
      localStream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      screenStream?.getTracks().forEach((t) => t.stop());
    } catch {}

    if (rawVideoTrackRef.current) {
      rawVideoTrackRef.current.stop();
    }
    clearInterval(sendLoopRef.current);
    videoProcRef.current?.stopRenderLoop?.();

    // Cleanup
    audioProcRef.current?.stop?.();
    roomSocketRef.current?.disconnect();
    moderationWsRef.current?.disconnect();

    navigate('/dashboard');
  }, [localStream, screenStream, navigate]);

  // ============================================================================
  // RENDERING
  // ============================================================================

  // Separate local tile from remote tiles to power the PiP engine
  const remoteTiles = useMemo(() => {
    return peers.map((p) => ({
      id: p.id,
      label: p.displayName || p.id.slice(0, 6),
      stream: streams[p.id] || null,
      muted: false,
      mediaState: peerMediaState[p.id] || {}
    }));
  }, [peers, streams, peerMediaState]);

  const getGridClass = (count) => {
    if (count === 0) return 'flex flex-col items-center justify-center';
    if (count === 1) return 'grid-cols-1 max-w-5xl mx-auto w-full';
    if (count === 2) return 'grid-cols-2 max-w-6xl mx-auto w-full';
    if (count <= 4) return 'grid-cols-2 grid-rows-2 max-w-6xl mx-auto w-full';
    if (count <= 6) return 'grid-cols-3 grid-rows-2 max-w-7xl mx-auto w-full';
    return 'grid-cols-auto-fit min-[300px]'; // generic wrapping
  };

  const hasLocalMedia = cameraEnabled || micEnabled;

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between border-b border-slate-900">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-brand-primary rounded-xl flex items-center justify-center font-black">
            B
          </div>
          <div>
            <div className="font-bold">BLURNET Meet</div>
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span className="font-mono">Room: {roomId}</span>
              <span
                className={`ml-2 ${
                  connected ? 'text-emerald-400' : 'text-slate-500'
                }`}
              >
                {connected ? 'Connected' : 'Connecting…'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={() => setAiOn((v) => !v)}
            className={`px-3 py-1.5 rounded-xl border ${
              aiOn
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-slate-800 bg-slate-900 text-slate-400'
            }`}
          >
            AI {aiOn ? 'On' : 'Off'}
          </button>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className="px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-800"
          >
            Chat
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden relative">
        
        {/* Unsafe Alert Overlay Banner */}
        <div 
          className={`absolute top-6 left-1/2 transform -translate-x-1/2 z-50 px-6 py-3 rounded-2xl bg-red-500/90 text-white font-semibold backdrop-blur-md shadow-[0_0_20px_rgba(239,68,68,0.4)] border border-red-400/50 flex items-center gap-3 transition-all duration-300 pointer-events-none ${showUnsafeAlert ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}`}
        >
          <span className="text-xl">⚠️</span>
          <span>Inappropriate content detected. This stream is being moderated.</span>
        </div>

        {/* Video Grid */}
        <div className="flex-1 p-4 flex flex-col">
          {!connected ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-lg font-semibold mb-2">Connecting to room…</div>
                <div className="text-slate-400">Please wait while we establish the connection</div>
              </div>
            </div>
          ) : !hasJoinedRoom ? (
            // Join-without-camera mode
            <div className="flex-1 flex flex-col items-center justify-center gap-6">
              <div className="text-center">
                <div className="text-3xl font-bold mb-2">Ready to join?</div>
                <div className="text-slate-400 mb-6">
                  You can view and chat without enabling camera/microphone
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <button
                  onClick={() => setIsScreenSharing(!isScreenSharing)}
                  className="px-6 py-4 bg-purple-500 hover:bg-purple-600 rounded-xl font-semibold transition"
                >
                  📺 Share Screen
                </button>
              </div>

              <button
                onClick={() => {}}
                className="px-8 py-3 bg-slate-800 hover:bg-slate-700 rounded-xl font-semibold"
              >
                Just View (no media)
              </button>

              {peers.length > 0 && (
                <div className="mt-6 text-center">
                  <div className="text-sm text-slate-400">
                    {peers.length} participant{peers.length !== 1 ? 's' : ''} already in this meeting
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Google Meet Dynamic Grid
            <div className={`grid gap-4 w-full h-full p-6 place-items-center ${getGridClass(remoteTiles.length)}`}>
              {remoteTiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-4 text-slate-500">
                  <div className="w-20 h-20 rounded-full bg-slate-800/50 flex items-center justify-center border border-slate-700/50">
                    <UserRound className="w-10 h-10 text-slate-600" />
                  </div>
                  <h2 className="text-xl font-medium text-slate-300">You're the only one here</h2>
                  <p className="text-sm">Waiting for others to join...</p>
                </div>
              ) : (
                remoteTiles.map((t) => (
                  <div key={t.id} className="w-full h-full min-h-[250px] max-h-[80vh] aspect-video">
                    <VideoTile
                      label={t.label}
                      stream={t.stream}
                      muted={t.muted}
                      isActiveSpeaker={t.id === activeSpeakerId}
                      hasRemoteVideo={t.mediaState?.video}
                      isRemoteAudioMuted={t.mediaState?.audio === false}
                    />
                  </div>
                ))
              )}
            </div>
          )}
        </div>

      </div>

      {/* Slide-in Chat Panel */}
      <div className={`fixed right-0 top-0 bottom-0 w-80 bg-slate-900 border-l border-slate-800/50 flex flex-col z-40 transform transition-transform duration-300 ease-out shadow-2xl ${chatOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="px-5 py-4 border-b border-slate-800/50 flex justify-between items-center bg-slate-900/50 backdrop-blur">
          <span className="font-semibold flex items-center gap-2"><MessageSquare className="w-4 h-4"/> Meeting Chat</span>
          <button onClick={() => setChatOpen(false)} className="text-slate-400 hover:text-white text-xl">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {chat.length === 0 ? (
            <div className="text-center text-slate-500 text-sm mt-10">Messages will appear here</div>
          ) : (
            chat.map((m, idx) => {
              const isSelf = m.from === self?.id;
              return (
                <div key={idx} className={`flex flex-col max-w-[85%] ${isSelf ? 'ml-auto items-end' : 'items-start'}`}>
                  <span className="text-[10px] text-slate-400 mb-1 px-1">
                    {isSelf ? 'You' : (peers.find(p => p.id === m.from)?.displayName || m.from?.slice(0, 6))}
                  </span>
                  <div className={`px-4 py-2 text-sm rounded-2xl ${
                    isSelf 
                      ? 'bg-blue-600 text-white rounded-br-sm' 
                      : 'bg-slate-800 text-slate-200 rounded-bl-sm border border-slate-700/50'
                  }`}>
                    {m.text}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="p-4 bg-slate-900/90 backdrop-blur border-t border-slate-800/50">
          <div className="flex gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
            <input
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' &&
                chatDraft.trim() &&
                (roomSocketRef.current?.send('chat', { text: chatDraft }), setChatDraft(''))
              }
              className="flex-1 bg-transparent px-3 outline-none text-sm placeholder:text-slate-500"
              placeholder="Message everyone..."
            />
            <button
              onClick={() => {
                if (chatDraft.trim()) {
                  roomSocketRef.current?.send('chat', { text: chatDraft });
                  setChatDraft('');
                }
              }}
              className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Floating Control Bar */}
      {hasJoinedRoom && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-slate-900/80 backdrop-blur-2xl border border-slate-700/50 rounded-full px-6 py-4 shadow-2xl z-50 transition-all duration-300">
          <button
            onClick={toggleMic}
            className={`group relative p-4 rounded-full transition-all duration-200 ${
              micEnabled && localStream?.getAudioTracks()[0]?.enabled
                ? 'bg-slate-800 hover:bg-slate-700'
                : 'bg-red-500 hover:bg-red-600'
            }`}
          >
            {micEnabled && localStream?.getAudioTracks()[0]?.enabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5 text-white" />}
            <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 mb-2 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
              Toggle Mic
            </span>
          </button>
          
          <button
            onClick={toggleCamera}
            className={`group relative p-4 rounded-full transition-all duration-200 ${
              cameraEnabled && localStream?.getVideoTracks()[0]?.enabled
                ? 'bg-slate-800 hover:bg-slate-700'
                : 'bg-red-500 hover:bg-red-600'
            }`}
          >
            {cameraEnabled && localStream?.getVideoTracks()[0]?.enabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5 text-white" />}
            <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 mb-2 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
              Toggle Camera
            </span>
          </button>

          <button
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
            className={`group relative p-4 rounded-full transition-all duration-200 ${
              isScreenSharing
                ? 'bg-emerald-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700'
            }`}
          >
            <MonitorUp className="w-5 h-5" />
            <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 mb-2 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
              {isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
            </span>
          </button>

          <div className="w-px h-8 bg-slate-700/50 mx-2" />

          <button
            onClick={() => setChatOpen(!chatOpen)}
            className={`group relative p-4 rounded-full transition-all duration-200 ${
              chatOpen ? 'bg-blue-600 text-white' : 'bg-slate-800 hover:bg-slate-700'
            }`}
          >
            <MessageSquare className="w-5 h-5" />
            <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 mb-2 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
              Chat
            </span>
          </button>

          <button
            onClick={leave}
            className="group relative p-4 rounded-full bg-red-600 hover:bg-red-700 transition-all duration-200 shadow-lg shadow-red-500/20"
          >
            <PhoneMissed className="w-5 h-5 text-white" />
            <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 mb-2 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
              Leave Call
            </span>
          </button>
        </div>
      )}

      {/* Picture-in-Picture Local Viewer */}
      {hasJoinedRoom && cameraEnabled && localStream && (
        <div className="fixed bottom-28 right-6 w-64 aspect-video rounded-2xl shadow-2xl border border-slate-700/50 bg-slate-900 z-40 overflow-hidden transform hover:scale-105 transition-transform cursor-pointer">
          <VideoTile
            label="You"
            stream={localStream}
            muted={true}
            showModerated={aiOn}
            moderationSocket={moderationWsRef.current}
            isActiveSpeaker={false}
          />
        </div>
      )}

      {/* Toast Notifications */}
      {toastMessage && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl font-semibold backdrop-blur-xl border ${
            toastType === 'error'
              ? 'bg-red-500/20 border-red-500/50 text-red-200'
              : toastType === 'success'
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                : 'bg-blue-500/20 border-blue-500/50 text-blue-200'
          }`}
        >
          {toastMessage}
        </div>
      )}

      {/* Audio Sanitized Banner */}
      {audioSanitized && (
        <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/30 text-red-200 text-sm font-semibold">
          ⚠️ Audio sanitized (temporary mic mute due to content moderation)
        </div>
      )}
    </div>
  );
}
