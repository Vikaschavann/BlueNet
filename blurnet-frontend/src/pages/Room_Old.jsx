import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RoomSocket } from '../utils/RoomSocket';
import { createPeerConnection } from '../utils/webrtcMesh';
import VideoTile from '../components/VideoTile';
import { WebSocketClient } from '../utils/WebSocketClient';
import { AudioProcessor } from '../utils/AudioProcessor';

function shortId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const SIGNAL_BASE = useMemo(
    () => import.meta.env.VITE_SIGNALING_WS_BASE || 'ws://localhost:8000/ws/room',
    [],
  );
  const MODERATION_WS = useMemo(
    () => import.meta.env.VITE_MODERATION_WS || 'ws://localhost:8000/ws/moderate',
    [],
  );

  const roomSocketRef = useRef(null);
  const moderationWsRef = useRef(null);
  const audioProcRef = useRef(null);
  const localStreamRef = useRef(null);
  const micOnRef = useRef(true);

  const [self, setSelf] = useState(null); // {id,isHost,displayName}
  const [peers, setPeers] = useState([]); // [{id,displayName,isHost}]
  const [streams, setStreams] = useState({}); // peerId -> MediaStream
  const [localStream, setLocalStream] = useState(null);
  const [mediaState, setMediaState] = useState('loading'); // loading | ready | denied | error
  const [mediaError, setMediaError] = useState('');
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState([]);
  const [chatDraft, setChatDraft] = useState('');

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [aiOn, setAiOn] = useState(true);
  const [activeSpeakerId, setActiveSpeakerId] = useState(null);
  const [audioSanitized, setAudioSanitized] = useState(false);

  const cameraStreamRef = useRef(null); // original camera stream
  const screenStreamRef = useRef(null); // active screen stream

  const pcsRef = useRef(new Map()); // peerId -> RTCPeerConnection
  const sendersRef = useRef(new Map()); // peerId -> { audioSender, videoSender }
  const politeRef = useRef(new Map()); // peerId -> boolean
  const rtcStateRef = useRef(new Map()); // peerId -> { makingOffer: boolean, polite: boolean }
  const pendingIceRef = useRef(new Map()); // peerId -> [{candidate}]
  const selfRef = useRef(null);
  const remoteStreamsRef = useRef(new Map()); // peerId -> MediaStream
  const pendingPeerIdsRef = useRef(new Set()); // peerIds to create PCs for after localStream is ready
  const pendingSignalsRef = useRef(new Map()); // peerId -> array of payloads

  // Active speaker detection (simple, local): choose the loudest remote track.
  const speakerAnalyzersRef = useRef(new Map()); // peerId -> { ctx, analyser, data }
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

  useEffect(() => {
    if (!roomId) navigate(`/room/${shortId()}`, { replace: true });
  }, [roomId, navigate]);

  useEffect(() => {
    selfRef.current = self;
  }, [self]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  useEffect(() => {
    let cancelled = false;
    setMediaState('loading');
    setMediaError('');

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) return;
        cameraStreamRef.current = stream;
        setLocalStream(stream); // local preview + outgoing video by default
        setMediaState('ready');
      } catch (e) {
        if (cancelled) return;
        console.error('[RTC] getUserMedia failed', e);
        const name = e?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setMediaState('denied');
          setMediaError('Camera/Microphone permission denied. Please allow access and try again.');
        } else {
          setMediaState('error');
          setMediaError(`Could not access camera/mic (${name || 'error'}).`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaAttempt]);

  useEffect(() => {
    if (!roomId) return;
    if (mediaState !== 'ready') return; // gate signaling until we can actually negotiate media
    const roomSocket = new RoomSocket({
      baseUrl: SIGNAL_BASE,
      roomId,
      onMessage: (msg) => handleRoomMessage(msg),
    });
    roomSocketRef.current = roomSocket;

    (async () => {
      await roomSocket.connect();
      setConnected(true);
    })().catch((e) => console.error('[ROOM] connect failed', e));

    return () => roomSocket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, SIGNAL_BASE, mediaState]);

  useEffect(() => {
    // IMPORTANT: single WS instance for the room lifecycle.
    const ws = new WebSocketClient(MODERATION_WS, (msg) => {
      // Single moderation channel; currently routed to local tile only.
      window.dispatchEvent(new CustomEvent('moderation:You', { detail: msg }));

      if (msg?.type === 'audio_result' && msg?.result?.abusive) {
        setAudioSanitized(true);
        // "Beep/mute" MVP: temporarily mute mic to prevent further transmission.
        const ls = localStreamRef.current;
        if (ls) ls.getAudioTracks().forEach((t) => (t.enabled = false));
        setTimeout(() => {
          setAudioSanitized(false);
          const ls2 = localStreamRef.current;
          const shouldBeOn = micOnRef.current;
          if (ls2) ls2.getAudioTracks().forEach((t) => (t.enabled = shouldBeOn));
        }, 2500);
      }
    });
    moderationWsRef.current = ws;
    return () => ws.disconnect();
  }, [MODERATION_WS]);

  // Start audio moderation for local mic (optional).
  useEffect(() => {
    if (!localStream) return;
    if (!aiOn) return;

    let stopped = false;
    (async () => {
      await moderationWsRef.current?.connect?.();
      if (stopped) return;
      audioProcRef.current = new AudioProcessor((chunk) => {
        moderationWsRef.current?.send?.('audio_chunk', chunk);
      });
      await audioProcRef.current.start(localStream);
    })().catch((e) => console.warn('[AI] audio moderation init failed', e));

    return () => {
      stopped = true;
      audioProcRef.current?.stop?.();
    };
  }, [localStream, aiOn]);

  const handleRoomMessage = async (msg) => {
    const type = msg?.type;
    const data = msg?.data || {};

    if (type === 'room_joined') {
      setSelf(data.self);
      setPeers(data.peers || []);
      // Determine polite role per peer (prevents offer glare).
      const selfId = data.self?.id;
      (data.peers || []).forEach((p) => {
        politeRef.current.set(p.id, selfId > p.id);
      });
      for (const p of data.peers || []) {
        await ensurePeer(p.id);
      }
      return;
    }

    if (type === 'peer_joined') {
      const p = data.peer;
      setPeers((prev) => prev.some((x) => x.id === p.id) ? prev : [...prev, p]);
      const curSelf = selfRef.current;
      if (curSelf?.id) politeRef.current.set(p.id, curSelf.id > p.id);
      await ensurePeer(p.id);
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
      await handleSignal(from, payload);
      return;
    }

    if (type === 'chat') {
      setChat((prev) => [...prev, { from: data.from, text: data.text, ts: Date.now() }]);
      return;
    }
  };

  const ensurePeer = async (peerId) => {
    if (!localStream) {
      pendingPeerIdsRef.current.add(peerId);
      return;
    }
    if (pcsRef.current.has(peerId)) return;

    const polite = politeRef.current.get(peerId) ?? true;

    const pc = createPeerConnection({
      onIceCandidate: (candidate) => {
        roomSocketRef.current?.send('signal', { to: peerId, payload: { candidate } });
      },
      onTrack: (e) => {
        // Some browsers deliver tracks without populated `event.streams[0]`.
        // We always construct/maintain a MediaStream per peer.
        if (!remoteStreamsRef.current.has(peerId)) {
          remoteStreamsRef.current.set(peerId, new MediaStream());
        }
        const rs = remoteStreamsRef.current.get(peerId);

        if (e.track) {
          const alreadyHas = rs.getTracks().some((t) => t.id === e.track.id);
          if (!alreadyHas) rs.addTrack(e.track);
        }

        setStreams((prev) => ({ ...prev, [peerId]: rs }));

        // Setup analyzer for active speaker (only if we have an audio track)
        const audioTrack = rs.getAudioTracks()[0];
        if (audioTrack && !speakerAnalyzersRef.current.has(peerId)) {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          const dataArr = new Uint8Array(analyser.fftSize);
          source.connect(analyser);
          speakerAnalyzersRef.current.set(peerId, { ctx, analyser, data: dataArr });
        }
      },
    });

    rtcStateRef.current.set(peerId, { makingOffer: false, polite });

    // Perfect negotiation: drive offers via `onnegotiationneeded` and handle glare.
    pc.onnegotiationneeded = async () => {
      const state = rtcStateRef.current.get(peerId);
      if (!state) return;
      if (!localStream) return;
      // Ignore while an offer is being created by this side.
      if (state.makingOffer) return;

      try {
           // Don’t create offers until we actually have something to send.
        const hasLiveTrack = pc.getSenders().some((s) => s.track && s.track.readyState === 'live');
        if (!hasLiveTrack) return;
        if (!roomSocketRef.current?.isConnected) return;

        state.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        roomSocketRef.current?.send('signal', { to: peerId, payload: { description: pc.localDescription } });
      } catch (e) {
        console.warn('[RTC] onnegotiationneeded offer failed', e);
      } finally {
        state.makingOffer = false;
      }
    };

    // Add tracks
    const audioTrack = localStream.getAudioTracks()[0];
    const videoTrack = localStream.getVideoTracks()[0];
    const audioSender = audioTrack ? pc.addTrack(audioTrack, localStream) : null;
    const videoSender = videoTrack ? pc.addTrack(videoTrack, localStream) : null;
    sendersRef.current.set(peerId, { audioSender, videoSender });

    pcsRef.current.set(peerId, pc);
  };

  const closePeer = (peerId) => {
    const pc = pcsRef.current.get(peerId);
    if (pc) {
      try { pc.close(); } catch { /* noop */ }
    }
    pcsRef.current.delete(peerId);
    sendersRef.current.delete(peerId);
    rtcStateRef.current.delete(peerId);
    pendingIceRef.current.delete(peerId);
    const rs = remoteStreamsRef.current.get(peerId);
    if (rs) {
      try { rs.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    }
    remoteStreamsRef.current.delete(peerId);

    const ana = speakerAnalyzersRef.current.get(peerId);
    if (ana) {
      try { ana.ctx.close(); } catch { /* noop */ }
    }
    speakerAnalyzersRef.current.delete(peerId);
  };

  const handleSignal = async (from, payload) => {
    // Buffer SDP/ICE until we have local media; otherwise negotiation may never happen.
    if (!localStream) {
      if (!pendingSignalsRef.current.has(from)) pendingSignalsRef.current.set(from, []);
      pendingSignalsRef.current.get(from).push(payload);
      return;
    }

    await ensurePeer(from);
    const pc = pcsRef.current.get(from);
    if (!pc) {
      if (!pendingSignalsRef.current.has(from)) pendingSignalsRef.current.set(from, []);
      pendingSignalsRef.current.get(from).push(payload);
      return;
    }

    if (payload.description) {
      const description = payload.description;
      const state = rtcStateRef.current.get(from) || { makingOffer: false, polite: politeRef.current.get(from) ?? true };

      // Glare handling: if we're also trying to negotiate and the peer sent an offer,
      // ignore it only if we are not "polite".
      const isOffer = description.type === 'offer';
      const offerCollision = isOffer && (state.makingOffer || pc.signalingState !== 'stable');
      const ignoreOffer = offerCollision && !state.polite;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(description);

      // Now that remote description is set, flush any ICE candidates we buffered earlier.
      const queuedIce = pendingIceRef.current.get(from) || [];
      if (queuedIce.length) {
        pendingIceRef.current.delete(from);
        for (const c of queuedIce) {
          try {
            await pc.addIceCandidate(c);
          } catch (e) {
            console.warn('[RTC] queued addIceCandidate failed', e);
          }
        }
      }

      if (isOffer) {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        roomSocketRef.current?.send('signal', { to: from, payload: { description: pc.localDescription } });
      }
    }

    if (payload.candidate) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch (e) {
        // If we got ICE before remoteDescription is set, buffer it.
        const list = pendingIceRef.current.get(from) || [];
        list.push(payload.candidate);
        pendingIceRef.current.set(from, list);
        console.warn('[RTC] addIceCandidate buffered (until remoteDescription)', e);
      }
    }
  };

  // Flush buffered peer creation + buffered signals once localStream becomes available.
  useEffect(() => {
    if (!localStream) return;
    let cancelled = false;
    (async () => {
      // Create any PCs we queued while localStream was loading.
      for (const pid of Array.from(pendingPeerIdsRef.current)) {
        if (cancelled) return;
        await ensurePeer(pid);
      }

      // Apply queued signals in order for each peer.
      for (const [pid, payloads] of Array.from(pendingSignalsRef.current.entries())) {
        if (!payloads || payloads.length === 0) continue;
        for (const pl of payloads) {
          if (cancelled) return;
          await handleSignal(pid, pl);
        }
      }

      pendingSignalsRef.current.clear();
      pendingPeerIdsRef.current.clear();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStream]);

  const toggleMic = () => {
    if (!localStream) return;
    const next = !micOn;
    setMicOn(next);
    localStream.getAudioTracks().forEach((t) => (t.enabled = next));
  };

  const toggleCam = () => {
    if (!localStream) return;
    const next = !camOn;
    setCamOn(next);
    localStream.getVideoTracks().forEach((t) => (t.enabled = next));
  };

  const startScreenShare = async () => {
    if (isScreenSharing) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) return;

      setIsScreenSharing(true);
      screenTrack.onended = () => stopScreenShare();

      // Ensure the outgoing track matches the screen share.
      screenTrack.enabled = camOn;
      screenStreamRef.current = display;

      const audioTracks = cameraStreamRef.current?.getAudioTracks?.() || localStreamRef.current?.getAudioTracks?.() || [];
      const outgoing = new MediaStream([screenTrack, ...audioTracks]);
      setLocalStream(outgoing);

      const cameraVideoTracks = cameraStreamRef.current?.getVideoTracks?.() || [];
      cameraVideoTracks.forEach((t) => {
        t.enabled = false; // Prevent camera frames from confusing local preview/state.
      });

      // Replace outgoing video track to all peers (no addTrack duplication).
      sendersRef.current.forEach((senders) => {
        senders.videoSender?.replaceTrack?.(screenTrack);
      });

    } catch (e) {
      console.warn('[RTC] screenshare failed', e);
    }
  };

  const stopScreenShare = () => {
    if (!isScreenSharing) return;

    const camTrack = cameraStreamRef.current?.getVideoTracks?.()[0];
    if (camTrack) {
      camTrack.enabled = camOn;
      sendersRef.current.forEach((senders) => {
        senders.videoSender?.replaceTrack?.(camTrack);
      });
    }

    try {
      screenStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    screenStreamRef.current = null;

    // Restore local/outgoing stream to camera preview.
    if (cameraStreamRef.current) setLocalStream(cameraStreamRef.current);

    setIsScreenSharing(false);
  };

  const retryMedia = () => {
    // Release any previous state if we got partially initialized.
    try {
      cameraStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    try {
      screenStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setPeers([]);
    setStreams({});
    pcsRef.current.forEach((_, pid) => closePeer(pid));
    setMediaAttempt((x) => x + 1);
  };

  const sendChat = () => {
    const text = chatDraft.trim();
    if (!text) return;
    roomSocketRef.current?.send('chat', { text });
    setChatDraft('');
  };

  const leave = () => {
    pcsRef.current.forEach((_, pid) => closePeer(pid));
    try {
      localStream?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    try {
      cameraStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    try {
      screenStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {}

    roomSocketRef.current?.disconnect();
    moderationWsRef.current?.disconnect();
    navigate('/dashboard');
  };

  const shareLink = async () => {
    const url = `${window.location.origin}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // ignore
    }
  };

  const tiles = useMemo(() => {
    const out = [];
    if (localStream) out.push({ id: 'local', label: 'You', stream: localStream, muted: true });
    peers.forEach((p) => {
      const s = streams[p.id];
      if (s) out.push({ id: p.id, label: p.displayName || p.id.slice(0, 6), stream: s, muted: false });
      else out.push({ id: p.id, label: p.displayName || p.id.slice(0, 6), stream: null, muted: false });
    });
    return out;
  }, [localStream, peers, streams]);

  if (mediaState !== 'ready') {
    return (
      <div className="h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-slate-900/50 border border-slate-800 rounded-2xl p-6 backdrop-blur-xl">
          <div className="text-lg font-bold mb-2">Starting secure meeting</div>
          <div className="text-slate-400 mb-4">
            {mediaState === 'loading' ? 'Requesting camera and microphone access…' : mediaError || 'Media permissions required.'}
          </div>
          {mediaState === 'denied' || mediaState === 'error' ? (
            <button
              onClick={retryMedia}
              className="w-full bg-brand-primary px-6 py-3 rounded-xl font-semibold hover:bg-blue-600 transition"
            >
              Retry permission
            </button>
          ) : (
            <div className="h-10 w-full bg-slate-800/60 rounded-xl animate-pulse" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between border-b border-slate-900">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-brand-primary rounded-xl flex items-center justify-center font-black">B</div>
          <div>
            <div className="font-bold">BLURNET Meet</div>
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span className="font-mono">Room: {roomId}</span>
              <button onClick={shareLink} className="text-brand-primary hover:underline">Copy link</button>
              <span className={`ml-2 ${connected ? 'text-emerald-400' : 'text-slate-500'}`}>{connected ? 'Connected' : 'Connecting…'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={() => setAiOn((v) => !v)} className={`px-3 py-1.5 rounded-xl border ${aiOn ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-800 bg-slate-900 text-slate-400'}`}>
            AI {aiOn ? 'On' : 'Off'}
          </button>
          <button onClick={() => setChatOpen((v) => !v)} className="px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-800">
            Chat
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 p-4">
          {audioSanitized && (
            <div className="mb-4 px-4 py-3 rounded-2xl border border-red-500/30 bg-red-500/10 text-red-200 font-semibold">
              Audio sanitized (temporary mic mute)
            </div>
          )}
          <div className="grid gap-4" style={{ gridTemplateColumns: tiles.length <= 2 ? '1fr 1fr' : 'repeat(3, minmax(0, 1fr))' }}>
            {tiles.map((t) => (
              <VideoTile
                key={t.id}
                label={t.label}
                stream={t.stream}
                muted={t.muted}
                showModerated={aiOn && t.id === 'local'}
                moderationSocket={moderationWsRef.current}
                isActiveSpeaker={t.id !== 'local' && t.id === activeSpeakerId}
              />
            ))}
          </div>
        </div>

        {chatOpen && (
          <div className="w-[360px] border-l border-slate-900 bg-slate-950 flex flex-col">
            <div className="px-4 py-3 border-b border-slate-900 font-semibold">Meeting chat</div>
            <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
              {chat.map((m, idx) => (
                <div key={idx} className="text-sm">
                  <div className="text-xs text-slate-500 font-mono">{m.from === self?.id ? 'you' : m.from?.slice(0, 6)}</div>
                  <div className="text-slate-200">{m.text}</div>
                </div>
              ))}
            </div>
            <div className="p-3 border-t border-slate-900 flex gap-2">
              <input
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 outline-none"
                placeholder="Message everyone"
              />
              <button onClick={sendChat} className="px-3 py-2 rounded-xl bg-brand-primary font-semibold hover:bg-blue-600">
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="p-5 flex justify-center border-t border-slate-900">
        <div className="bg-slate-900/70 backdrop-blur-xl border border-slate-800 rounded-2xl px-6 py-3 flex items-center gap-3 shadow-2xl">
          <button onClick={toggleMic} className={`px-4 py-2 rounded-xl font-semibold ${micOn ? 'bg-slate-800 hover:bg-slate-700' : 'bg-red-500 hover:bg-red-600'}`}>
            {micOn ? 'Mic on' : 'Mic off'}
          </button>
          <button onClick={toggleCam} className={`px-4 py-2 rounded-xl font-semibold ${camOn ? 'bg-slate-800 hover:bg-slate-700' : 'bg-red-500 hover:bg-red-600'}`}>
            {camOn ? 'Cam on' : 'Cam off'}
          </button>
          <button
            onClick={() => (isScreenSharing ? stopScreenShare() : startScreenShare())}
            className={`px-4 py-2 rounded-xl font-semibold ${isScreenSharing ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700'}`}
          >
            {isScreenSharing ? 'Stop share' : 'Share screen'}
          </button>
          <div className="w-px h-8 bg-slate-800 mx-1" />
          <button onClick={leave} className="px-5 py-2 rounded-xl bg-red-500 hover:bg-red-600 font-black">
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

