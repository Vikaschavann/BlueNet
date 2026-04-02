/**
 * Production-ready WebRTC Peer Connection Hook (Google Meet style)
 * Goal: Seamless switching, zero black screens, remote stream updates natively
 */
import { useCallback, useRef, useState, useEffect } from 'react';

const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export function usePeerConnections({ sendSignal, onRemoteTrack }) {
  const pcsRef = useRef(new Map());
  const rtcStateRef = useRef(new Map()); // { makingOffer, polite }
  
  const [localStream, setLocalStream] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);

  const rawCameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  
  useEffect(() => {
    return () => closeAll();
  }, []);

  /**
   * 1. TRACK MANAGEMENT (CRITICAL)
   * Maintain single video sender. Use replaceTrack() instead of adding tracks.
   */
  const replaceTrackOnPeers = useCallback(async (trackKind, newTrack, stream) => {
    for (const [peerId, pc] of pcsRef.current.entries()) {
      let transceiver = pc.getTransceivers().find(t => 
        !t.stopped && (t.receiver?.track?.kind === trackKind || t.sender?.track?.kind === trackKind)
      );

      if (transceiver && transceiver.sender) {
        try {
          // Use replaceTrack! Avoids renegotiation overhead entirely if direction is unchanged
          await transceiver.sender.replaceTrack(newTrack || null);
          console.log(`[RTC] Replaced ${trackKind} track for peer ${peerId}`);
          
          if (newTrack) {
            if (transceiver.direction === 'recvonly') transceiver.direction = 'sendrecv';
            else if (transceiver.direction === 'inactive') transceiver.direction = 'sendonly';
          } else {
            // Mute scenario
            if (transceiver.direction === 'sendrecv') transceiver.direction = 'recvonly';
            else if (transceiver.direction === 'sendonly') transceiver.direction = 'inactive';
          }
        } catch (e) {
          console.error(`[RTC] replaceTrack failed for ${peerId}:`, e);
        }
      } else if (newTrack && stream) {
        pc.addTrack(newTrack, stream);
        console.log(`[RTC] Added ${trackKind} track to PC for peer ${peerId}`);
      }
    }
  }, []);

  /**
   * 2. SIGNALING + RENEGOTIATION
   */
  const createPeerConnection = useCallback((peerId, polite) => {
    if (pcsRef.current.has(peerId)) return pcsRef.current.get(peerId);

    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);
    rtcStateRef.current.set(peerId, { makingOffer: false, polite });

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      // Pass the remote stream efficiently
      if (onRemoteTrack) onRemoteTrack(peerId, e.track, e.streams[0]);
    };

    // Handle negotiationneeded elegantly (only fires when sender direction explicitly changes bounds)
    pc.onnegotiationneeded = async () => {
      const state = rtcStateRef.current.get(peerId);
      if (!state || state.makingOffer) return;
      try {
        state.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.error('[RTC] onnegotiationneeded error:', err);
      } finally {
        state.makingOffer = false;
      }
    };

    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    pcsRef.current.set(peerId, pc);
    return pc;
  }, [localStream, sendSignal, onRemoteTrack]);

  const handleSignal = useCallback(async (peerId, payload) => {
    const pc = pcsRef.current.get(peerId);
    if (!pc) return;

    if (payload.description) {
      const state = rtcStateRef.current.get(peerId);
      const isOffer = payload.description.type === 'offer';
      const offerCollision = isOffer && (state.makingOffer || pc.signalingState !== 'stable');
      if (offerCollision && !state.polite) return;

      await pc.setRemoteDescription(payload.description);
      if (isOffer) {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(peerId, { description: pc.localDescription });
      }
    } else if (payload.candidate) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch (e) {
        console.warn('[RTC] ICE candidate error:', e);
      }
    }
  }, [sendSignal]);

  /**
   * 3. CAMERA HANDLING
   * Get camera using getUserMedia & Add track safely
   */
  const initCamera = useCallback(async () => {
    if (cameraEnabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      rawCameraTrackRef.current = stream.getVideoTracks()[0];
      
      setLocalStream(stream);
      setCameraEnabled(true);

      stream.getTracks().forEach(async t => {
        await replaceTrackOnPeers(t.kind, t, stream);
      });
    } catch (err) {
      console.error("[RTC] initCamera failed", err);
    }
  }, [cameraEnabled, replaceTrackOnPeers]);

  /* 
   * 4. SWITCH BACK TO CAMERA 
   */
  const stopScreenShare = useCallback(async () => {
    if (!isScreenSharing) return;
    
    setIsScreenSharing(false);

    try {
      if (cameraEnabled) {
        console.log('[RTC] Re-acquiring camera using getUserMedia...');
        const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newVideoTrack = newStream.getVideoTracks()[0];
        
        if (rawCameraTrackRef.current) rawCameraTrackRef.current.stop();
        rawCameraTrackRef.current = newVideoTrack;

        const audioTracks = localStream ? localStream.getAudioTracks() : [];
        const combinedStream = new MediaStream([...audioTracks, newVideoTrack]);
        setLocalStream(combinedStream);

        // Replace back using replaceTrack BEFORE ending the screen share natively
        await replaceTrackOnPeers('video', newVideoTrack, combinedStream);
      } else {
        // Safe mute
        await replaceTrackOnPeers('video', null, null);
        const audioTracks = localStream ? localStream.getAudioTracks() : [];
        setLocalStream(audioTracks.length > 0 ? new MediaStream(audioTracks) : null);
      }
    } catch (err) {
      console.error('[RTC] Error restoring camera:', err);
      setCameraEnabled(false);
    } finally {
      // AVOID MISUSE: Destruct screen track ONLY AFTER replacement is piped securely!
      // This prevents RTCRtpSender from trying to transmit a permanently killed dead canvas/display!
      if (screenTrackRef.current) {
        screenTrackRef.current.onended = null;
        screenTrackRef.current.stop();
        screenTrackRef.current = null;
      }
    }
  }, [isScreenSharing, cameraEnabled, localStream, replaceTrackOnPeers]);

  /**
   * 5. SCREEN SHARE HANDLING
   */
  const startScreenShare = useCallback(async () => {
    if (isScreenSharing) return;

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) return;

      screenTrackRef.current = screenTrack;
      // Edge Case: User cancels via browser UI natively
      screenTrack.onended = stopScreenShare;

      // DO NOT STOP camera completely here, otherwise remote peers might break. 
      // But if user requested resource cleanup, we drop the hardware link cleanly. 
      if (cameraEnabled && rawCameraTrackRef.current) {
        rawCameraTrackRef.current.stop();
        rawCameraTrackRef.current = null;
      }

      setIsScreenSharing(true);

      const activeAudio = localStream ? localStream.getAudioTracks() : [];
      const newLocal = new MediaStream([screenTrack, ...activeAudio]);
      setLocalStream(newLocal);

      // Instantly swap view to display
      await replaceTrackOnPeers('video', screenTrack, newLocal);

      console.log('[RTC] Screen share successfully mapped and routed');
    } catch (err) {
      console.warn('[RTC] Screen share failed or cancelled:', err);
    }
  }, [isScreenSharing, cameraEnabled, localStream, stopScreenShare, replaceTrackOnPeers]);

  const closeAll = useCallback(() => {
    pcsRef.current.forEach(pc => pc.close());
    pcsRef.current.clear();
    
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (rawCameraTrackRef.current) rawCameraTrackRef.current.stop();
    if (screenTrackRef.current) screenTrackRef.current.stop();
  }, [localStream]);

  return {
    createPeerConnection,
    handleSignal,
    initCamera,
    startScreenShare,
    stopScreenShare,
    replaceTrack: replaceTrackOnPeers,
    closeAll,
    
    localStream,
    isScreenSharing,
    cameraEnabled,
    pcsRef
  };
}
