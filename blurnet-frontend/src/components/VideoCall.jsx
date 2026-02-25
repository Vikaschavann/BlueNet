import React, { useEffect, useRef, useState } from 'react';
import { Camera, Shield, ShieldAlert, Mic, MicOff, Settings, Info } from 'lucide-react';
import { WebSocketClient } from '../utils/WebSocketClient';
import { VideoProcessor } from '../utils/VideoProcessor';
import { AudioProcessor } from '../utils/AudioProcessor';

const VideoCall = () => {
    const localVideoRef = useRef(null);
    const canvasRef = useRef(null);
    const wsRef = useRef(null);
    const videoProcRef = useRef(new VideoProcessor({ width: 640, height: 480 }));
    const audioProcRef = useRef(null);

    const [status, setStatus] = useState('Disconnected');
    const [isUnsafe, setIsUnsafe] = useState(false);
    const [regions, setRegions] = useState([]);
    const [isAbusive, setIsAbusive] = useState(false);
    const [isActive, setIsActive] = useState(false);
    const [loading, setLoading] = useState(false);
    const [lockdownActive, setLockdownActive] = useState(false);

    // Refs for Zero-Lag Loop
    const isActiveRef = useRef(false);
    const sendFrameTriggerRef = useRef(null);

    useEffect(() => {
        isActiveRef.current = isActive;
    }, [isActive]);

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
            const resultRegions = data.regions || [];
            const resultMaxScore = data.max_score || 0;

            setIsUnsafe(resultUnsafe);
            setRegions(resultRegions);

            // Sync with processor for render loop (Updating this.blurRegions)
            if (videoProcRef.current) {
                videoProcRef.current.setRegions(resultRegions, resultMaxScore);
            }

            if (resultUnsafe) {
                console.log("[AI] Unsafe regions detected:", resultRegions.length);
                setLockdownActive(true);
            }

            // TRIGGER NEXT FRAME (Self-Correcting Loop)
            if (sendFrameTriggerRef.current) {
                setTimeout(sendFrameTriggerRef.current, 50);
            }
        } else if (data.type === 'audio_result') {
            const result = data.result;
            if (result.abusive) {
                setIsAbusive(true);
                if (audioProcRef.current) audioProcRef.current.setMute(true);
                setTimeout(() => {
                    setIsAbusive(false);
                    if (audioProcRef.current) audioProcRef.current.setMute(false);
                }, 3000);
            }
        }
    };

    // --- Lockdown Timer (UI Sync) ---
    useEffect(() => {
        let timer;
        if (lockdownActive) {
            timer = setTimeout(() => {
                setLockdownActive(false);
            }, 5000);
        }
        return () => clearTimeout(timer);
    }, [lockdownActive]);

    const startCall = async () => {
        setLoading(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: true
            });

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }

            await wsRef.current.connect();
            setIsActive(true);
            setStatus('Active Moderation');

            // Start Audio
            audioProcRef.current = new AudioProcessor((chunk) => {
                wsRef.current.send('audio_chunk', chunk);
            });
            await audioProcRef.current.start(stream);

            // --- NEW: Self-Correcting Frame Loop ---
            // Instead of setInterval (which causes lag buildup), 
            // we send frames as fast as the backend can process them.
            const sendNextFrame = () => {
                if (!wsRef.current || !wsRef.current.isConnected || !isActiveRef.current) return;

                const frame = videoProcRef.current.extractFrame(localVideoRef.current);
                if (frame) {
                    wsRef.current.send('video_frame', frame);
                }
            };

            // Store function in ref so handleMessage can call it
            sendFrameTriggerRef.current = sendNextFrame;

            // Initial trigger
            setTimeout(sendNextFrame, 500);

            // Start the Integrated Render Loop
            videoProcRef.current.startRenderLoop(localVideoRef.current, canvasRef.current);

        } catch (err) {
            console.error('Call failed:', err);
            setStatus('Connection Error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 space-y-6">
                <div className="glass-card p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-4">
                            <div className={`w-3 h-3 rounded-full ${isActive ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-700'}`}></div>
                            <div>
                                <h1 className="text-lg font-bold text-white leading-none">Guardia Real-Time</h1>
                                <p className="text-xs text-zinc-500 mt-1">{status}</p>
                            </div>
                        </div>
                        {lockdownActive ? (
                            <div className="flex items-center gap-2 px-4 py-1.5 bg-red-600 border border-red-400 rounded-full animate-pulse shadow-[0_0_15px_rgba(220,38,38,0.5)]">
                                <ShieldAlert size={16} className="text-white" />
                                <span className="text-[11px] font-black text-white uppercase tracking-tighter">LOCKDOWN MODE ACTIVE</span>
                            </div>
                        ) : isUnsafe && (
                            <div className="flex items-center gap-2 px-3 py-1 bg-red-500/10 border border-red-500/20 rounded-full animate-bounce">
                                <ShieldAlert size={14} className="text-red-500" />
                                <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Shield Engaged</span>
                            </div>
                        )}
                    </div>

                    {/* DUAL SCREEN VIDEO GRID */}
                    <div className="video-grid">
                        {/* 1. RAW FEED */}
                        <div className="video-container shadow-2xl">
                            <div className="label-tag">Raw Preview (No Blur)</div>
                            <video
                                ref={localVideoRef}
                                className="video-element"
                                autoPlay
                                muted
                                playsInline
                            />
                        </div>

                        {/* 2. MODERATED FEED */}
                        <div className="video-container shadow-2xl ring-2 ring-emerald-500/20">
                            <div className="label-tag bg-emerald-500/80">AI Moderated Stream</div>
                            <canvas
                                ref={canvasRef}
                                width={640}
                                height={480}
                                className="video-element"
                            />

                            {/* UI INDICATORS */}
                            {isUnsafe && (
                                <div className="absolute inset-0 border-4 border-red-500 animate-pulse pointer-events-none z-20">
                                    <div className="absolute top-0 left-0 right-0 bg-red-500/80 py-1 text-center font-black text-white text-[9px] uppercase tracking-[0.2em]">
                                        Sensitive Content Detected - Selective Blur Active
                                    </div>
                                </div>
                            )}

                            {!isActive && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md">
                                    <div className="w-10 h-10 border-2 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mb-4"></div>
                                    <p className="text-white text-xs font-bold uppercase tracking-widest text-center px-6 leading-relaxed opacity-60">
                                        Initializing Core Moderation Engine...
                                    </p>
                                </div>
                            )}

                            {isAbusive && (
                                <div className="absolute bottom-6 left-6 right-6 flex items-center justify-center gap-3 bg-white text-black p-3 rounded-xl font-black text-xs shadow-2xl z-20 animate-bounce transition-all">
                                    <MicOff size={16} />
                                    <span className="uppercase tracking-wide">Audio Signal Sanitized</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex gap-4 mt-8">
                        <button
                            onClick={startCall}
                            disabled={isActive || loading}
                            className={`control-btn flex-1 flex items-center justify-center gap-3 py-4 text-sm font-black uppercase tracking-[0.1em] ${isActive ? 'bg-zinc-800 text-zinc-600' : 'btn-primary'}`}
                        >
                            {loading ? 'Initializing...' : <><Camera size={20} /> Start Protected Call</>}
                        </button>
                    </div>
                </div>
            </div>

            <div className="lg:col-span-4 space-y-6">
                <div className="glass-card p-6">
                    <h3 className="flex items-center gap-2 text-xs font-black text-zinc-400 uppercase tracking-widest mb-6">
                        <Settings size={14} /> System Health
                    </h3>
                    <div className="space-y-4 font-mono text-[10px]">
                        <div className="flex justify-between items-center border-b border-white/5 pb-2">
                            <span className="text-zinc-500">Video Pipeline</span>
                            <span className="text-emerald-500">640x480 @ 5fps</span>
                        </div>
                        <div className="flex justify-between items-center border-b border-white/5 pb-2">
                            <span className="text-zinc-500">AI Latency</span>
                            <span className="text-emerald-500">~120ms</span>
                        </div>
                        <div className="flex justify-between items-center border-b border-white/5 pb-2">
                            <span className="text-zinc-500">WebSocket Buffer</span>
                            <span className="text-emerald-500">0ms</span>
                        </div>
                        <div className="mt-4 p-3 bg-black/40 rounded-lg">
                            <p className="text-[9px] text-zinc-400 leading-relaxed italic">
                                Detection is performed using NudeNet V2 on backend. Frames are sent as base64-encoded JPEGs (70% quality).
                            </p>
                        </div>
                    </div>
                </div>

                <div className="glass-card p-6 bg-gradient-to-br from-indigo-500/5 to-emerald-500/5">
                    <h3 className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-6">
                        <Info size={14} /> Live Logs
                    </h3>
                    <div className="bg-black/20 rounded-xl p-4 h-48 overflow-y-auto scroller font-mono text-[9px] text-zinc-500 space-y-1">
                        <p>{`[` + new Date().toLocaleTimeString() + `] Initializing UI...`}</p>
                        {isActive && <p className="text-zinc-300">{`[` + new Date().toLocaleTimeString() + `] WebSocket connected.`}</p>}
                        {isUnsafe && <p className="text-red-400">{`[` + new Date().toLocaleTimeString() + `] ALERT: Unsafe region detected!`}</p>}
                        {isAbusive && <p className="text-yellow-400">{`[` + new Date().toLocaleTimeString() + `] ALERT: Audio sanitization active.`}</p>}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VideoCall;
