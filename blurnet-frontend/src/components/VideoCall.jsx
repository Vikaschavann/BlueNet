import React, { useState, useEffect, useRef } from 'react';
import { WebSocketClient } from '../utils/WebSocketClient';
import { VideoProcessor } from '../utils/VideoProcessor';
import { AudioProcessor } from '../utils/AudioProcessor';

const VideoCall = () => {
  const [isModerationActive, setIsModerationActive] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const canvasRef = useRef(null);

  const localStreamRef = useRef(null);
  const pcRef = useRef(null);
  const isInitializingRef = useRef(false);

  const wsRef = useRef(null);
  const videoProcRef = useRef(new VideoProcessor({ width: 640, height: 480 }));
  const audioProcRef = useRef(null);
  const isActiveRef = useRef(false);
  const sendFrameTriggerRef = useRef(null);

  const safeStopStream = (stream) => {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {
        console.warn('Track stop error', e);
      }
    });
  };

  const cleanupPeerConnection = () => {
    if (pcRef.current) {
      try {
        pcRef.current.getSenders().forEach((sender) => {
          if (sender.track) sender.track.stop();
        });
        pcRef.current.close();
      } catch (e) {
        console.warn('PC cleanup error', e);
      }
      pcRef.current = null;
    }
  };

  const cleanLocalStream = () => {
    if (localStreamRef.current) {
      safeStopStream(localStreamRef.current);
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    localStreamRef.current = null;
    setIsCameraOn(false);
    setIsMicOn(true);
  };

  const initPeerConnection = () => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.ontrack = (event) => {
      if (!remoteVideoRef.current) return;
      const [remoteStream] = event.streams;
      if (remoteStream && remoteVideoRef.current.srcObject !== remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.warn('ICE connection state', pc.iceConnectionState);
      }
    };

    pcRef.current = pc;
    return pc;
  };

  const addOrReplaceTracks = (stream) => {
    const pc = initPeerConnection();
    const senders = pc.getSenders();

    stream.getTracks().forEach((track) => {
      const existingSender = senders.find((s) => s.track && s.track.kind === track.kind);
      if (existingSender) {
        existingSender.replaceTrack(track);
      } else {
        pc.addTrack(track, stream);
      }
    });
  };

  const initLocalMedia = async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    if (isInitializingRef.current) {
      throw new Error('Media initialization already in progress');
    }

    isInitializingRef.current = true;
    setError(null);

    try {
      if (localStreamRef.current) {
        safeStopStream(localStreamRef.current);
        localStreamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: true,
      });

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setIsCameraOn(true);
      setIsMicOn(true);
      return stream;
    } catch (err) {
      console.error('initLocalMedia failed', err);
      setError(err.message || 'Unable to access camera/microphone.');
      cleanLocalStream();
      throw err;
    } finally {
      isInitializingRef.current = false;
    }
  };

  const startCall = async () => {
    if (isModerationActive || loading) return;

    setLoading(true);
    try {
      const stream = await initLocalMedia();

      const ws = wsRef.current || new WebSocketClient('ws://localhost:8000/ws/moderate', handleMessage);
      wsRef.current = ws;
      if (!ws.isConnected) await ws.connect();

      const pc = initPeerConnection();
      addOrReplaceTracks(stream);

      if (audioProcRef.current) audioProcRef.current.stop();
      audioProcRef.current = new AudioProcessor((chunk) => {
        ws.send('audio_chunk', chunk);
      });
      await audioProcRef.current.start(stream);

      const sendNextFrame = () => {
        if (!ws.isConnected || !isActiveRef.current) return;
        const frame = videoProcRef.current.extractFrame(localVideoRef.current);
        if (frame) ws.send('video_frame', frame);
      };
      sendFrameTriggerRef.current = sendNextFrame;
      setTimeout(sendNextFrame, 500);

      videoProcRef.current.startRenderLoop(localVideoRef.current, canvasRef.current);

      setIsModerationActive(true);
      isActiveRef.current = true;
    } catch (err) {
      console.error('startCall failed', err);
      if (err.name === 'NotAllowedError') {
        setError('Camera/microphone permission was denied. Please allow to continue.');
      } else if (err.name === 'NotReadableError') {
        setError('Camera is busy or not available. Close other apps using camera and retry.');
      }
    } finally {
      setLoading(false);
    }
  };

  const endCall = () => {
    setIsModerationActive(false);
    isActiveRef.current = false;

    if (audioProcRef.current) {
      audioProcRef.current.stop();
      audioProcRef.current = null;
    }
    if (videoProcRef.current) {
      videoProcRef.current.stopRenderLoop();
    }

    if (wsRef.current) {
      wsRef.current.disconnect();
      wsRef.current = null;
    }

    cleanupPeerConnection();
    cleanLocalStream();

    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  };

  const toggleCamera = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;
    setIsCameraOn(videoTrack.enabled);
  };

  const toggleMicrophone = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    setIsMicOn(audioTrack.enabled);
  };

  const retryPermission = async () => {
    if (isInitializingRef.current) return;

    cleanLocalStream();
    try {
      await initLocalMedia();
      if (isModerationActive) startCall();
    } catch (err) {
      console.warn('retryPermission failed', err);
    }
  };

  const startScreenShare = async () => {
    if (!pcRef.current) return;

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;

      const videoSender = pcRef.current.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
      } else {
        pcRef.current.addTrack(screenTrack, displayStream);
      }

      screenTrack.onended = async () => {
        const localVideoTrack = localStreamRef.current?.getVideoTracks()[0];
        if (localVideoTrack) {
          await startCall();
          const sender = pcRef.current.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) await sender.replaceTrack(localVideoTrack);
        }
      };
    } catch (err) {
      console.error('startScreenShare failed', err);
    }
  };

  useEffect(() => {
    isActiveRef.current = isModerationActive;
  }, [isModerationActive]);

  useEffect(() => {
    return () => {
      if (audioProcRef.current) audioProcRef.current.stop();
      if (videoProcRef.current) videoProcRef.current.stopRenderLoop();
      if (wsRef.current) wsRef.current.disconnect();
      cleanupPeerConnection();
      cleanLocalStream();
    };
  }, []);

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col overflow-hidden font-sans">
      <div className="p-4 flex justify-between items-center z-20">
        <div className="flex items-center gap-2 font-bold">
          <div className="w-8 h-8 bg-brand-primary rounded flex items-center justify-center">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04M12 21.48V22M12 21.48c-.766 0-1.521-.07-2.257-.204M12 21.48c.766 0 1.521-.07 2.257-.204m-4.514-.408l-.311 1.242m4.825-1.242l.311 1.242M9.621 19.74H12m0 0H14.379m-4.758 0L9 21.48M14.379 19.74L15 21.48" />
            </svg>
          </div>
          Silent Guardian AI
        </div>
        <div className="flex items-center gap-4 text-sm font-semibold">
          <div className={`px-4 py-1.5 rounded-full flex items-center gap-2 ${isModerationActive ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-slate-800 text-slate-400'}`}>
            <span className={`w-2 h-2 rounded-full ${isModerationActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
            {isModerationActive ? 'Moderation Active' : 'AI Offline'}
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 grid grid-cols-2 gap-4">
        <div className="relative rounded-2xl overflow-hidden border-2 border-brand-primary bg-slate-900 group flex items-center justify-center">
          {!isModerationActive ? (
            <button onClick={startCall} disabled={loading} className="px-6 py-3 bg-brand-primary hover:bg-blue-600 rounded-brand font-bold text-white shadow-xl transition z-10">
              {loading ? 'Initializing Engine...' : 'Enable Secure Camera'}
            </button>
          ) : (
            <video ref={localVideoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
          )}
          <div className="absolute top-4 right-4 bg-brand-primary text-[10px] font-bold px-2 py-0.5 rounded tracking-widest">YOU (RAW FEED)</div>
        </div>

        <div className={`relative rounded-2xl overflow-hidden border-2 bg-slate-900 ${error ? 'border-red-500' : 'border-slate-800'}`}>
          <div className="w-full h-full relative border-none bg-black flex items-center justify-center">
            {!isModerationActive ? (
              <div className="text-slate-600 font-mono text-sm">[ Awaiting Video Stream ]</div>
            ) : (
              <canvas ref={canvasRef} width={640} height={480} className="w-full h-full object-cover" />
            )}
          </div>
        </div>

        <div className="relative rounded-2xl overflow-hidden border border-slate-800 bg-slate-900">
          <video ref={remoteVideoRef} className="w-full h-full object-cover" autoPlay playsInline />
          <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-xs">Remote Participant</div>
        </div>

        <div className="relative rounded-2xl border border-slate-800 bg-slate-900 flex items-center justify-center">
          <div className="w-40 h-40 rounded-full bg-slate-800 border-4 border-slate-700 flex items-center justify-center text-5xl font-bold text-slate-500">LC</div>
          <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-xs">AI Companion</div>
        </div>
      </div>

      <div className="p-8 flex justify-center z-20">
        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-2xl px-8 py-4 flex items-center gap-4 shadow-2xl">
          <button onClick={toggleCamera} disabled={!localStreamRef.current} className={`px-4 py-2 rounded-xl ${isCameraOn ? 'bg-emerald-500' : 'bg-slate-700 hover:bg-slate-600'}`}>
            {isCameraOn ? 'Camera On' : 'Camera Off'}
          </button>
          <button onClick={toggleMicrophone} disabled={!localStreamRef.current} className={`px-4 py-2 rounded-xl ${isMicOn ? 'bg-emerald-500' : 'bg-slate-700 hover:bg-slate-600'}`}>
            {isMicOn ? 'Mic On' : 'Mic Off'}
          </button>
          <button onClick={startScreenShare} disabled={!pcRef.current || !localStreamRef.current} className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500">Share Screen</button>
          <button onClick={retryPermission} className="px-4 py-2 rounded-xl bg-yellow-500 hover:bg-yellow-400">Retry Permissions</button>
          <button onClick={endCall} className="px-6 py-3 bg-red-500 hover:bg-red-600 rounded-xl font-bold">End Call</button>
        </div>
      </div>

      {error && <div className="fixed bottom-4 right-4 bg-red-600 px-4 py-2 rounded-lg text-white">{error}</div>}
    </div>
  );
};

export default VideoCall;
