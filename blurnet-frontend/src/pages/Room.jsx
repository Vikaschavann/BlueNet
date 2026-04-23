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
 * - Join room â†’ Can see peers immediately (no permission prompt)
 * - Click "Enable Camera" â†’ Request camera permission
 * - Click "Enable Mic" â†’ Request mic permission
 * - Click "Share Screen" â†’ Request screen permission
 * 
 * If permission denied:
 * - Show error toast
 * - User can still see/hear others
 * - Chat remains available
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Mic, MicOff, Video, VideoOff, MonitorUp, PhoneMissed, MessageSquare, ShieldAlert, UserRound, Copy, Users, Check, Crown, PanelRightOpen } from 'lucide-react';
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
import { useNsfwDetector, getNsfwModel } from '../hooks/useNsfwDetector';
import { useObjectDetector } from '../hooks/useObjectDetector';
import { useAuth } from '../context/AuthContext';
import '../styles/meet.css';

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
  const [roomFull, setRoomFull] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  const [maxPeers] = useState(12);
  const [linkCopied, setLinkCopied] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
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

  useEffect(() => { aiOnRef.current = aiOn; }, [aiOn]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);
  useEffect(() => { isCameraBlockedRef.current = isCameraBlocked; }, [isCameraBlocked]);

  // CLIENT-SIDE NSFW DETECTION — Fast in-browser first-pass using TensorFlow.js + nsfwjs
  // This catches explicit content (including phones showing porn) within ~50ms
  const handleClientNsfw = useCallback((result) => {
    const proc = videoProcRef.current;
    if (!proc) return;
    console.log(`[NSFW.js] Client-side detection: ${result.category} @ ${(result.nsfwScore * 100).toFixed(1)}%`);
    proc.triggerGlobalBlur(800, 'blur');
    if (!unsafeAlertRef.current) {
      unsafeAlertRef.current = true;
      setShowUnsafeAlert(true);
    }
  }, []);

  const { isLoading: nsfwModelLoading } = useNsfwDetector(
    rawVideoRef,
    { enabled: aiOn && cameraEnabled, interval: 300, onUnsafe: handleClientNsfw }
  );

  // YOLO OBJECT DETECTION — specifically looking for cell phones
  const yoloDetectionsRef = useRef([]);
  const { isLoading: objModelLoading } = useObjectDetector(
    rawVideoRef,
    { 
      enabled: cameraEnabled, 
      interval: 500, 
      targetClass: 'cell phone',
      onDetect: (detections) => {
        yoloDetectionsRef.current = detections;
      },
      onCrops: (crops) => {
        getNsfwModel().then(async (nsfwModel) => {
          const tf = await import('@tensorflow/tfjs');
          for (const crop of crops) {
            try {
              // 1. Run NSFW classification on the cropped tensor
              const predictions = await nsfwModel.classify(crop.tensor, 5);
              
              // 2. Tally NSFW score
              const nsfwCategories = ['Porn', 'Sexy', 'Hentai'];
              const nsfwPreds = predictions.filter(p => nsfwCategories.includes(p.className));
              const topNsfw = nsfwPreds.reduce((max, p) => p.probability > max.probability ? p : max, { className: 'None', probability: 0 });
              
              const isUnsafe = topNsfw.probability > 0.5;

              // 3. Mark the region unsafe via surgical blur
              if (isUnsafe) {
                console.log(`[PIPELINE] 🚨 NSFW PHONE DETECTED: ${topNsfw.className} at ${(topNsfw.probability * 100).toFixed(1)}%`);
                
                const proc = videoProcRef.current;
                if (proc) {
                  const [x, y, w, h] = crop.bbox;
                  proc.addSurgicalRegion({ x, y, width: w, height: h, label: 'NSFW_PHONE', confidence: topNsfw.probability }, 15);
                }

                if (!unsafeAlertRef.current) {
                  unsafeAlertRef.current = true;
                  setShowUnsafeAlert(true);
                }
              }
            } catch (err) {
              console.error("[PIPELINE] Failed classifying crop:", err);
            } finally {
              // ALWAYS clean up WebGL memory
              tf.dispose(crop.tensor);
            }
          }
        });
      }
    }
  );


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
      onMessage: handleRoomMessage,
    });
    roomSocketRef.current = roomSocket;

    // Connect to signaling immediately (no media needed)
    (async () => {
      try {
        await roomSocket.connect();
        console.log('[ROOM] Connected to signaling');
        setConnected(true);
        // Send authenticated user's display name
        if (user?.name) {
          roomSocket.send('set_name', { displayName: user.name });
        }
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

      if (type === 'room_full') {
        setRoomFull(true);
        showToast(`Room is full (max ${data.maxPeers} participants)`, 'error');
        return;
      }

      if (type === 'room_joined') {
        setSelf(data.self);
        setPeers(data.peers || []);
        setParticipantCount(data.peerCount || (data.peers || []).length + 1);
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
        if (data.peerCount) setParticipantCount(data.peerCount);
        else setParticipantCount((prev) => prev + 1);
        const curSelf = selfRef.current;
        if (curSelf?.id) politeRef.current.set(p.id, curSelf.id > p.id);
        ensurePeer(p.id);
        showToast(`${p.displayName || 'Someone'} joined the meeting`, 'info');
        return;
      }

      if (type === 'peer_left') {
        const pid = data.peerId;
        setPeers((prev) => prev.filter((p) => p.id !== pid));
        setParticipantCount((prev) => Math.max(1, prev - 1));
        setStreams((prev) => {
          const copy = { ...prev };
          delete copy[pid];
          return copy;
        });
        closePeer(pid);
        showToast('A participant left the meeting', 'info');
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

      if (type === 'peer_updated') {
        const updatedPeer = data.peer;
        setPeers((prev) => prev.map((p) =>
          p.id === updatedPeer.id ? { ...p, ...updatedPeer } : p
        ));
        return;
      }

      if (type === 'host_changed') {
        const hostId = data.hostId;
        setPeers((prev) => prev.map((p) => ({ ...p, isHost: p.id === hostId })));
        setSelf((prev) => prev ? { ...prev, isHost: prev.id === hostId } : prev);
        showToast('Host has changed', 'info');
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
        const processedStream = processedCanvasRef.current.captureStream(15);
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
            sendLoopRef.current = setTimeout(loop, 150);
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
        video: { frameRate: { ideal: 60, max: 60 } },
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
          if (now - proc.lastFrameSentAt > 500) {
             console.log("Failsafe: Backend lagging >500ms");
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

  // Helper to get a peer's display name by ID
  const getPeerName = useCallback((peerId) => {
    if (peerId === self?.id) return user?.name || 'You';
    const peer = peers.find((p) => p.id === peerId);
    return peer?.displayName || peerId?.slice(0, 6) || 'Unknown';
  }, [self, peers, user]);

  // Separate local tile from remote tiles to power the PiP engine
  const remoteTiles = useMemo(() => {
    return peers.map((p) => ({
      id: p.id,
      label: p.displayName || p.id.slice(0, 6),
      isHost: p.isHost || false,
      stream: streams[p.id] || null,
      muted: false,
      mediaState: peerMediaState[p.id] || {}
    }));
  }, [peers, streams, peerMediaState]);

  const getGridLayout = (count) => {
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    if (count <= 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 3, rows: 2 };
    if (count <= 9) return { cols: 3, rows: 3 };
    return { cols: 4, rows: 3 };
  };

  const hasLocalMedia = cameraEnabled || micEnabled;
  const totalTiles = remoteTiles.length;
  const { cols, rows } = getGridLayout(totalTiles);
  const timeString = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="meet-room">
      {/* â”€â”€ Top Bar â”€â”€ */}
      <div className="meet-topbar">
        <div className="meet-topbar-left">
          <div className="meet-logo">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect width="24" height="24" rx="6" fill="#4285F4"/>
              <path d="M7 8.5V15.5H12.5L15 13V11L12.5 8.5H7Z" fill="white"/>
              <path d="M15 11L18 8.5V15.5L15 13V11Z" fill="white" opacity="0.8"/>
            </svg>
            <span className="meet-title">BlurNet Meet</span>
          </div>
          <div className="meet-divider-v" />
          <div className="meet-info-pills">
            <span className="meet-time">{timeString}</span>
            <span className="meet-room-code">{roomId}</span>
            <button className="meet-copy-btn" onClick={() => { navigator.clipboard.writeText(window.location.href); setLinkCopied(true); showToast('Meeting link copied!', 'success'); setTimeout(() => setLinkCopied(false), 2000); }} title="Copy meeting link">
              {linkCopied ? <Check className="w-4 h-4" style={{color:'#34a853'}} /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div className="meet-topbar-right">
          <button onClick={() => setAiOn((v) => !v)} className={`meet-pill ${aiOn ? 'meet-pill-active' : ''}`}>
            <ShieldAlert className="w-4 h-4" /> AI {aiOn ? 'On' : 'Off'}
          </button>
          <div className="meet-pill"><Users className="w-4 h-4" /><span>{participantCount}</span></div>
        </div>
      </div>

      {/* â”€â”€ Alert â”€â”€ */}
      <div className={`meet-alert ${showUnsafeAlert ? 'meet-alert-show' : ''}`}>
        <span>âš ï¸</span><span>Content moderated â€” inappropriate content detected</span>
      </div>

      {/* â”€â”€ Stage â”€â”€ */}
      <div className="meet-stage">
        {roomFull ? (
          <div className="meet-empty-state">
            <div className="meet-empty-icon" style={{background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.3)'}}>
              <Users className="w-10 h-10" style={{color: '#ef4444'}} />
            </div>
            <h2>This meeting is full</h2>
            <p>Maximum of {maxPeers} participants reached</p>
            <button onClick={() => navigate('/dashboard')} className="meet-join-btn">Back to Home</button>
          </div>
        ) : !connected ? (
          <div className="meet-empty-state">
            <div className="meet-spinner" />
            <h2>Joining the meeting...</h2>
            <p>Establishing a secure connection</p>
          </div>
        ) : !hasJoinedRoom ? (
          <div className="meet-prejoin">
            <div className="meet-prejoin-preview">
              <div className="meet-preview-card">
                <div className="meet-preview-avatar">
                  <span>{(user?.name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}</span>
                </div>
                <div className="meet-preview-label">{user?.name || 'You'}</div>
              </div>
            </div>
            <div className="meet-prejoin-info">
              <h1 className="meet-prejoin-title">Ready to join?</h1>
              <p className="meet-prejoin-sub">{peers.length > 0 ? `${peers.length} other${peers.length !== 1 ? 's' : ''} in this meeting` : 'No one else is here yet'}</p>
              <div className="meet-prejoin-share">
                <div className="meet-share-label">Meeting link</div>
                <div className="meet-share-row">
                  <code className="meet-share-url">{window.location.href}</code>
                  <button className={`meet-share-copy ${linkCopied ? 'copied' : ''}`} onClick={() => { navigator.clipboard.writeText(window.location.href); setLinkCopied(true); showToast('Link copied!', 'success'); setTimeout(() => setLinkCopied(false), 2000); }}>
                    {linkCopied ? 'âœ“ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              {peers.length > 0 && (
                <div className="meet-prejoin-peers">
                  {peers.slice(0, 4).map(p => (<div key={p.id} className="meet-peer-chip">{(p.displayName || 'G')[0].toUpperCase()}</div>))}
                  {peers.length > 4 && <span className="meet-peer-more">+{peers.length - 4}</span>}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="meet-grid" style={{ gridTemplateColumns: totalTiles === 0 ? '1fr' : `repeat(${cols}, 1fr)`, gridTemplateRows: totalTiles === 0 ? '1fr' : `repeat(${rows}, 1fr)` }}>
            {totalTiles === 0 ? (
              <div className="meet-empty-state">
                <div className="meet-empty-icon"><UserRound className="w-10 h-10" /></div>
                <h2>You're the only one here</h2>
                <p>Share the meeting link to invite others</p>
              </div>
            ) : (
              remoteTiles.map((t) => (
                <div key={t.id} className="meet-tile-wrapper">
                  <VideoTile label={t.label} stream={t.stream} muted={t.muted} isActiveSpeaker={t.id === activeSpeakerId} hasRemoteVideo={t.mediaState?.video} isRemoteAudioMuted={t.mediaState?.audio === false} isHost={t.isHost} />
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* â”€â”€ Chat Panel â”€â”€ */}
      <div className={`meet-panel ${chatOpen ? 'meet-panel-open' : ''}`}>
        <div className="meet-panel-header">
          <span className="meet-panel-title"><MessageSquare className="w-4 h-4"/> Meeting Chat</span>
          <button onClick={() => setChatOpen(false)} className="meet-panel-close">&times;</button>
        </div>
        <div className="meet-panel-body">
          {chat.length === 0 ? (<div className="meet-panel-empty">Messages will appear here</div>) : (
            chat.map((m, idx) => {
              const isSelf = m.from === self?.id;
              return (
                <div key={idx} className={`meet-chat-msg ${isSelf ? 'meet-chat-self' : ''}`}>
                  <span className="meet-chat-sender">{isSelf ? 'You' : getPeerName(m.from)}</span>
                  <div className={`meet-chat-bubble ${isSelf ? 'meet-chat-bubble-self' : ''}`}>{m.text}</div>
                </div>
              );
            })
          )}
        </div>
        <div className="meet-panel-footer">
          <div className="meet-chat-input-row">
            <input value={chatDraft} onChange={(e) => setChatDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && chatDraft.trim() && (roomSocketRef.current?.send('chat', { text: chatDraft }), setChatDraft(''))} className="meet-chat-input" placeholder="Send a message..." />
            <button onClick={() => { if (chatDraft.trim()) { roomSocketRef.current?.send('chat', { text: chatDraft }); setChatDraft(''); } }} className="meet-chat-send"><MessageSquare className="w-4 h-4" /></button>
          </div>
        </div>
      </div>

      {/* â”€â”€ Participants Panel â”€â”€ */}
      <div className={`meet-panel ${participantsOpen ? 'meet-panel-open' : ''}`}>
        <div className="meet-panel-header">
          <span className="meet-panel-title"><Users className="w-4 h-4"/> People ({participantCount})</span>
          <button onClick={() => setParticipantsOpen(false)} className="meet-panel-close">&times;</button>
        </div>
        <div className="meet-panel-body">
          <div className="meet-participant meet-participant-self">
            <div className="meet-participant-avatar meet-participant-avatar-you">{(user?.name || 'Y').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}</div>
            <div className="meet-participant-info">
              <div className="meet-participant-name">{user?.name || 'You'} <span className="meet-participant-you">(You)</span></div>
            </div>
            {self?.isHost && <span className="meet-host-badge"><Crown className="w-3 h-3"/> Host</span>}
          </div>
          {peers.map((p) => {
            const initials = (p.displayName || 'G').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
            const pm = peerMediaState[p.id] || {};
            return (
              <div key={p.id} className="meet-participant">
                <div className="meet-participant-avatar">{initials}</div>
                <div className="meet-participant-info">
                  <div className="meet-participant-name">{p.displayName || p.id.slice(0, 8)}</div>
                  <div className="meet-participant-media">
                    {pm.audio !== false ? <span className="meet-media-on"><Mic className="w-3 h-3"/> On</span> : <span className="meet-media-off"><MicOff className="w-3 h-3"/> Off</span>}
                    {pm.video ? <span className="meet-media-on"><Video className="w-3 h-3"/> On</span> : <span className="meet-media-off"><VideoOff className="w-3 h-3"/> Off</span>}
                  </div>
                </div>
                {p.isHost ? <span className="meet-host-badge"><Crown className="w-3 h-3"/> Host</span> : <span className="meet-member-badge">Member</span>}
              </div>
            );
          })}
          {peers.length === 0 && <div className="meet-panel-empty">No other participants yet</div>}
        </div>
      </div>

      {/* â”€â”€ Bottom Controls â”€â”€ */}
      {hasJoinedRoom && (
        <div className="meet-controls">
          <div className="meet-controls-left">
            <span className="meet-controls-time">{timeString}</span>
            <span className="meet-controls-room">{roomId}</span>
          </div>
          <div className="meet-controls-center">
            <button onClick={toggleMic} className={`meet-ctrl-btn ${micEnabled && localStream?.getAudioTracks()[0]?.enabled ? '' : 'meet-ctrl-off'}`} title="Toggle microphone">
              {micEnabled && localStream?.getAudioTracks()[0]?.enabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
            </button>
            <button onClick={toggleCamera} className={`meet-ctrl-btn ${cameraEnabled && localStream?.getVideoTracks()[0]?.enabled ? '' : 'meet-ctrl-off'}`} title="Toggle camera">
              {cameraEnabled && localStream?.getVideoTracks()[0]?.enabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
            </button>
            <button onClick={isScreenSharing ? stopScreenShare : startScreenShare} className={`meet-ctrl-btn ${isScreenSharing ? 'meet-ctrl-active' : ''}`} title={isScreenSharing ? 'Stop presenting' : 'Present now'}>
              <MonitorUp className="w-5 h-5" />
            </button>
            <button onClick={leave} className="meet-ctrl-btn meet-ctrl-leave" title="Leave call">
              <PhoneMissed className="w-5 h-5" />
            </button>
          </div>
          <div className="meet-controls-right">
            <button onClick={() => { setChatOpen(!chatOpen); if (participantsOpen) setParticipantsOpen(false); }} className={`meet-ctrl-btn-sm ${chatOpen ? 'meet-ctrl-sm-active' : ''}`} title="Chat">
              <MessageSquare className="w-5 h-5" />
            </button>
            <button onClick={() => { setParticipantsOpen(!participantsOpen); if (chatOpen) setChatOpen(false); }} className={`meet-ctrl-btn-sm ${participantsOpen ? 'meet-ctrl-sm-active' : ''}`} title="People">
              <Users className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* â”€â”€ Self-View PiP â”€â”€ */}
      {hasJoinedRoom && cameraEnabled && localStream && (
        <div className="meet-pip">
          <VideoTile 
            label={user?.name || 'You'} 
            stream={localStream} 
            muted={true} 
            showModerated={aiOn} 
            moderationSocket={moderationWsRef.current} 
            isActiveSpeaker={false} 
            isHost={self?.isHost} 
            yoloDetectionsRef={yoloDetectionsRef}
          />
        </div>
      )}

      {/* â”€â”€ Toast â”€â”€ */}
      {toastMessage && <div className={`meet-toast meet-toast-${toastType}`}>{toastMessage}</div>}

      {/* â”€â”€ Audio Warning â”€â”€ */}
      {audioSanitized && <div className="meet-audio-warn">âš ï¸ Audio muted â€” content moderation active</div>}
    </div>
  );
}
