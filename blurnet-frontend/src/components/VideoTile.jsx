import React, { useEffect, useMemo, useRef, useState } from 'react';
import { UserRound, MicOff, Crown } from 'lucide-react';
import BoundingBoxOverlay from './BoundingBoxOverlay';

export default function VideoTile({
  label,
  stream,
  muted = false,
  isActiveSpeaker = false,
  hasRemoteVideo,
  isRemoteAudioMuted,
  isHost = false,
  yoloDetectionsRef = null,
}) {
  const videoRef = useRef(null);
  const [videoError, setVideoError] = useState('');

  // Determine if we should show fallback intelligently blending custom signals and native tracking
  const hasVideo = hasRemoteVideo !== undefined 
    ? hasRemoteVideo 
    : (stream && stream.getVideoTracks().length > 0);
    
  const isAudioMuted = isRemoteAudioMuted !== undefined 
    ? isRemoteAudioMuted 
    : (stream && stream.getAudioTracks()[0] && !stream.getAudioTracks()[0].enabled);

  const tileBorder = useMemo(() => {
    if (isActiveSpeaker) return 'border-emerald-500 shadow-[0_0_30px_rgba(16,185,129,0.18)]';
    return 'border-slate-800';
  }, [isActiveSpeaker]);

  // Generate initials from label
  const initials = useMemo(() => {
    if (!label || label === 'You') return '?';
    return label.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }, [label]);

  // Failsafe UI Debug
  useEffect(() => {
    if (!stream || label === 'You') return;
    const interval = setInterval(() => {
      if (videoRef.current) {
        if (!videoRef.current.srcObject) {
          setVideoError('No remote stream received (srcObject null)');
          console.error(`[VideoTile] ERROR: ${label} fail - srcObject is null`);
        } else if (videoRef.current.readyState === 0) {
          setVideoError('No remote stream received (readyState 0)');
          console.error(`[VideoTile] ERROR: ${label} fail - readyState is 0 (HAVE_NOTHING)`);
        } else {
          setVideoError('');
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [stream, label]);

  useEffect(() => {
    if (!videoRef.current) return;

    if (!stream || !hasVideo) {
      videoRef.current.srcObject = null;   // 🔥 FIX FREEZE
      return;
    }

    if (videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }

    if (stream) {
      // NOTE: Using muted={muted} prop in JSX instead of hardcoded true 
      // dynamically prevents remote peers from being muted globally.
      videoRef.current.onloadedmetadata = () => {
        videoRef.current.play().catch(() => {});
      };
    }
  }, [stream, hasVideo]);

  return (
    <div className={`relative w-full h-full rounded-2xl overflow-hidden shadow-xl bg-slate-900 border transition-all duration-300 group ${tileBorder}`}>
      {/* Name Tag */}
      <div className="absolute bottom-3 left-3 z-20 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 shadow-lg">
        {isHost && <Crown className="w-3.5 h-3.5 text-amber-400" />}
        <span className="truncate max-w-[160px]">{label}</span>
        {isHost && <span className="text-amber-400/70 text-[10px]">Host</span>}
        {videoError && <span className="text-red-400 px-1 rounded">{videoError}</span>}
      </div>

      {/* Audio Muted Indicator */}
      {(muted || isAudioMuted) && (
        <div className="absolute top-3 right-3 z-20 bg-red-500/80 backdrop-blur-md p-1.5 rounded-full shadow-lg">
          <MicOff className="w-4 h-4 text-white" />
        </div>
      )}

      {/* Avatar Fallback with Initials */}
      {(!hasVideo || videoError) && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-800 z-10">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center shadow-inner border border-slate-600/50">
            <span className="text-3xl font-bold text-slate-300">{initials}</span>
          </div>
        </div>
      )}

      <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted={muted} />
      
      {/* YOLO Object Detection Overlay */}
      <BoundingBoxOverlay detectionsRef={yoloDetectionsRef} videoRef={videoRef} />
    </div>
  );
}

