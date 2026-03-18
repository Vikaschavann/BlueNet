import React, { useState, useEffect, useRef } from 'react';
import { WebSocketClient } from '../utils/WebSocketClient';
import { VideoProcessor } from '../utils/VideoProcessor';
import { AudioProcessor } from '../utils/AudioProcessor';

const VideoCall = () => {
  const [isModerationActive, setIsModerationActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isUnsafe, setIsUnsafe] = useState(false);
  const [lockdownActive, setLockdownActive] = useState(false);
  const [isAbusive, setIsAbusive] = useState(false);

  const localVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const videoProcRef = useRef(new VideoProcessor({ width: 640, height: 480 }));
  const audioProcRef = useRef(null);

  const isActiveRef = useRef(false);
  const sendFrameTriggerRef = useRef(null);

  useEffect(() => {
    isActiveRef.current = isModerationActive;
  }, [isModerationActive]);

  useEffect(() => {
    const ws = new WebSocketClient('ws://localhost:8000/ws/moderate', handleMessage);
    wsRef.current = ws;

    return () => {
        ws.disconnect();
        if (audioProcRef.current) audioProcRef.current.stop();
        if (videoProcRef.current) videoProcRef.current.stopRenderLoop();
    };
  }, []);

  const handleMessage = (data) => {
    if (data.type === 'moderation_result') {
        const resultUnsafe = data.unsafe;
        setIsUnsafe(resultUnsafe);
        if (videoProcRef.current) {
            videoProcRef.current.setRegions(data.regions || [], data.max_score || 0);
        }
        if (resultUnsafe) {
            setLockdownActive(true);
        }
        if (sendFrameTriggerRef.current) {
            // Self-correcting fast-loop mechanism
            setTimeout(sendFrameTriggerRef.current, 30);
        }
    } else if (data.type === 'audio_result') {
        if (data.result.abusive) {
            setIsAbusive(true);
            if (audioProcRef.current) audioProcRef.current.setMute(true);
            setTimeout(() => {
                setIsAbusive(false);
                if (audioProcRef.current) audioProcRef.current.setMute(false);
            }, 3000);
        }
    }
  };

  useEffect(() => {
      let timer;
      if (lockdownActive) {
          timer = setTimeout(() => {
              setLockdownActive(false);
          }, 800);
      }
      return () => clearTimeout(timer);
  }, [lockdownActive]);

  const startCall = async () => {
    setLoading(true);
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        
        await wsRef.current.connect();
        setIsModerationActive(true);

        audioProcRef.current = new AudioProcessor((chunk) => {
            wsRef.current.send('audio_chunk', chunk);
        });
        await audioProcRef.current.start(stream);

        const sendNextFrame = () => {
            if (!wsRef.current || !wsRef.current.isConnected || !isActiveRef.current) return;
            const frame = videoProcRef.current.extractFrame(localVideoRef.current);
            if (frame) wsRef.current.send('video_frame', frame);
        };
        sendFrameTriggerRef.current = sendNextFrame;
        setTimeout(sendNextFrame, 500);

        videoProcRef.current.startRenderLoop(localVideoRef.current, canvasRef.current);
    } catch (err) {
        console.error('Call failed', err);
    } finally {
        setLoading(false);
    }
  };

  const endCall = () => {
      setIsModerationActive(false);
      if (audioProcRef.current) audioProcRef.current.stop();
      if (videoProcRef.current) videoProcRef.current.stopRenderLoop();
      wsRef.current.disconnect();
      if (localVideoRef.current && localVideoRef.current.srcObject) {
          localVideoRef.current.srcObject.getTracks().forEach(track => track.stop());
          localVideoRef.current.srcObject = null;
      }
  };

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col overflow-hidden font-sans">
      {/* Header */}
      <div className="p-4 flex justify-between items-center z-20">
        <div className="flex items-center gap-2 font-bold">
           <div className="w-8 h-8 bg-brand-primary rounded flex items-center justify-center">
             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04M12 21.48V22M12 21.48c-.766 0-1.521-.07-2.257-.204M12 21.48c.766 0 1.521-.07 2.257-.204m-4.514-.408l-.311 1.242m4.825-1.242l.311 1.242M9.621 19.74H12m0 0H14.379m-4.758 0L9 21.48M14.379 19.74L15 21.48" /></svg>
           </div>
           Silent Guardian AI
        </div>
        <div className="flex items-center gap-4 text-sm font-semibold">
          <div className={`px-4 py-1.5 rounded-full flex items-center gap-2 ${isModerationActive ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-slate-800 text-slate-400'}`}>
            <span className={`w-2 h-2 rounded-full ${isModerationActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`}></span>
            {isModerationActive ? 'Moderation Active' : 'AI Offline'}
          </div>
          <button className="p-2 hover:bg-white/10 rounded-full">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          </button>
        </div>
      </div>

      {/* Main Grid */}
      <div className="flex-1 p-4 grid grid-cols-2 gap-4">
        
        {/* Participant 1 - User (Raw Stream) */}
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

        {/* Participant 3 - Live Moderated Output (Canvas) */}
        <div className={`relative rounded-2xl overflow-hidden border-2 bg-slate-900 ${isUnsafe ? 'border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.3)]' : 'border-slate-800'}`}>
           <div className="w-full h-full relative border-none bg-black flex items-center justify-center">
              {!isModerationActive ? (
                 <div className="text-slate-600 font-mono text-sm">[ Awaiting Video Stream ]</div>
              ) : (
                 <canvas ref={canvasRef} width={640} height={480} className="w-full h-full object-cover" />
              )}
              
              {/* Audio Abuse Sanitization Overlay */}
              {isAbusive && (
                  <div className="absolute inset-0 bg-red-500/20 backdrop-blur-sm z-30 flex flex-col items-center justify-center animate-pulse">
                      <svg className="w-12 h-12 text-white drop-shadow-lg mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.633L5.586 15z" clipRule="evenodd"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/></svg>
                      <span className="bg-red-600 text-white font-black px-3 py-1 text-xs uppercase tracking-widest rounded-full">Audio Sanitized</span>
                  </div>
              )}
              {lockdownActive && (
                  <div className="absolute top-4 left-4 bg-red-600/90 text-[10px] font-black tracking-widest px-2 py-1 rounded text-white animate-pulse">SURGICAL BLUR ACTIVE</div>
              )}
           </div>
           <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-xs">AI Moderated Feed</div>
        </div>

        {/* Participant 2 - Standard */}
        <div className="relative rounded-2xl overflow-hidden border border-slate-800 bg-slate-900">
           <img src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=800" className="w-full h-full object-cover opacity-80" />
           <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-xs">Sarah Miller</div>
        </div>

        {/* Participant 4 - Avatar Style */}
        <div className="relative rounded-2xl border border-slate-800 bg-slate-900 flex items-center justify-center">
           <div className="w-40 h-40 rounded-full bg-slate-800 border-4 border-slate-700 flex items-center justify-center text-5xl font-bold text-slate-500">
              LC
           </div>
           <div className="absolute bottom-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1 rounded-lg text-xs">Liam Carter</div>
        </div>
      </div>

      {/* Control Bar */}
      <div className="p-8 flex justify-center z-20">
        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-2xl px-8 py-4 flex items-center gap-6 shadow-2xl">
          <button className={`p-3 rounded-xl transition ${isAbusive ? 'bg-red-500 text-white animate-bounce' : 'bg-slate-800 hover:bg-slate-700'}`}>
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
          </button>
          <button className="p-3 bg-slate-800 hover:bg-slate-700 rounded-xl transition">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
          </button>
          <button className="p-3 bg-slate-800 hover:bg-slate-700 rounded-xl transition">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
          </button>
          <div className="h-8 w-px bg-slate-800"></div>
          <button onClick={endCall} className="px-6 py-3 bg-red-500 hover:bg-red-600 rounded-xl font-bold transition">
            End Call
          </button>
        </div>
      </div>
    </div>
  );
};

export default VideoCall;
