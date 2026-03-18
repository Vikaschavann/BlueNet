import React, { useEffect, useMemo, useRef, useState } from 'react';
import { VideoProcessor } from '../utils/VideoProcessor';

export default function VideoTile({
  label,
  stream,
  muted = false,
  showModerated = false,
  moderationSocket, // WebSocketClient-compatible: { send(type,data), isConnected }
  isActiveSpeaker = false,
}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const procRef = useRef(null);
  const sendLoopRef = useRef(null);
  const activeRef = useRef(false);

  const [unsafe, setUnsafe] = useState(false);

  const tileBorder = useMemo(() => {
    if (unsafe) return 'border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.25)]';
    if (isActiveSpeaker) return 'border-emerald-500 shadow-[0_0_30px_rgba(16,185,129,0.18)]';
    return 'border-slate-800';
  }, [unsafe, isActiveSpeaker]);

  useEffect(() => {
    if (!procRef.current) procRef.current = new VideoProcessor({ width: 640, height: 480 });
    return () => {
      procRef.current?.stopRenderLoop?.();
    };
  }, []);

  useEffect(() => {
    activeRef.current = Boolean(showModerated);
  }, [showModerated]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream || null;
  }, [stream, showModerated]);

  useEffect(() => {
    const proc = procRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!proc || !video || !canvas) return;

    if (showModerated) proc.startRenderLoop(video, canvas);
    else proc.stopRenderLoop();
  }, [showModerated, stream]);

  const handleModerationMessage = (data) => {
    if (data?.type !== 'moderation_result') return;
    setUnsafe(Boolean(data.unsafe));
    procRef.current?.setRegions?.(data.regions || [], data.max_score || 0);
    if (sendLoopRef.current) setTimeout(sendLoopRef.current, 30);
  };

  // Lightweight per-tile moderation loop (sampled frames, drops when busy).
  useEffect(() => {
    if (!showModerated) return;
    if (!moderationSocket) return;

    // Wrap only once per tile by swapping the onMessage handler upstream is out-of-scope.
    // So: we expect caller to route moderation results to this tile via `window` event.
    const handler = (e) => handleModerationMessage(e.detail);
    window.addEventListener(`moderation:${label}`, handler);

    const sendNext = () => {
      if (!activeRef.current) return;
      if (!moderationSocket.isConnected) return;
      const frame = procRef.current?.extractFrame?.(videoRef.current);
      if (frame) moderationSocket.send('video_frame', frame);
    };
    sendLoopRef.current = sendNext;
    setTimeout(sendNext, 600);

    return () => {
      window.removeEventListener(`moderation:${label}`, handler);
      sendLoopRef.current = null;
    };
  }, [showModerated, moderationSocket, label]);

  return (
    <div className={`relative rounded-2xl overflow-hidden border bg-slate-900 ${tileBorder}`}>
      <div className="absolute top-3 left-3 z-20 bg-black/40 backdrop-blur-md px-2.5 py-1 rounded-lg text-[11px] font-semibold">
        {label}
      </div>

      {!showModerated ? (
        <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted={muted} />
      ) : (
        <>
          <video ref={videoRef} className="absolute opacity-0 pointer-events-none w-[1px] h-[1px]" autoPlay playsInline muted={muted} />
          <canvas ref={canvasRef} width={640} height={480} className="w-full h-full object-cover" />
        </>
      )}
    </div>
  );
}

