/**
 * usePeerConnections Hook
 * 
 * Manages RTCPeerConnection lifecycle with LAZY track addition:
 * - Create PC without local tracks initially (receive-only mode)
 * - Add local tracks via addLocalTracks() only after permissions granted
 * - Handle track replacement (for camera toggle, screen share, etc.)
 * - Graceful cleanup
 */

import { useCallback, useRef } from 'react';

const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

export function usePeerConnections() {
  const pcsRef = useRef(new Map()); // peerId -> RTCPeerConnection
  const sendersRef = useRef(new Map()); // peerId -> { audioSender, videoSender }

  /**
   * Create a new peer connection (receive-only initially, no tracks)
   */
  const createPeerConnection = useCallback((peerId, { onIceCandidate, onTrack, rtcConfig = DEFAULT_RTC_CONFIG }) => {
    if (pcsRef.current.has(peerId)) {
      console.warn(`[RTC] PeerConnection already exists for ${peerId}`);
      return pcsRef.current.get(peerId);
    }

    const pc = new RTCPeerConnection(rtcConfig);

    // Handle ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate && onIceCandidate) {
        onIceCandidate(peerId, e.candidate);
      }
    };

    // Handle receiving remote tracks
    pc.ontrack = (e) => {
      console.log(`[RTC] Received track from ${peerId}:`, e.track.kind);
      if (onTrack) {
        onTrack(peerId, e);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[RTC] ${peerId} connection state: ${pc.connectionState}`);
    };

    pcsRef.current.set(peerId, pc);
    sendersRef.current.set(peerId, { audioSender: null, videoSender: null });

    console.log(`[RTC] Created receive-only PeerConnection for ${peerId}`);
    return pc;
  }, []);

  /**
   * Add local tracks to an existing PC (call after getUserMedia)
   * Replaces existing tracks if already present
   */
  const addLocalTracks = useCallback((peerId, localStream) => {
    const pc = pcsRef.current.get(peerId);
    if (!pc) {
      console.error(`[RTC] No PeerConnection for ${peerId}`);
      return;
    }

    if (!localStream) {
      console.warn(`[RTC] No local stream provided for ${peerId}`);
      return;
    }

    const senders = sendersRef.current.get(peerId) || {};
    let audioSender = senders.audioSender;
    let videoSender = senders.videoSender;

    // Add or replace audio track
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      if (audioSender) {
        // Replace existing audio track
        audioSender.replaceTrack(audioTrack).catch((err) => {
          console.warn(`[RTC] Failed to replace audio track for ${peerId}:`, err);
        });
      } else {
        // Add new audio sender
        audioSender = pc.addTrack(audioTrack, localStream);
        console.log(`[RTC] Added audio track to ${peerId}`);
      }
    }

    // Add or replace video track
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      if (videoSender) {
        // Replace existing video track
        videoSender.replaceTrack(videoTrack).catch((err) => {
          console.warn(`[RTC] Failed to replace video track for ${peerId}:`, err);
        });
      } else {
        // Add new video sender
        videoSender = pc.addTrack(videoTrack, localStream);
        console.log(`[RTC] Added video track to ${peerId}`);
      }
    }

    sendersRef.current.set(peerId, { audioSender, videoSender });
    console.log(`[RTC] Local tracks added for ${peerId}`);
  }, []);

  /**
   * Replace a specific track (e.g., for screen share or camera toggle)
   */
  const replaceTrack = useCallback((peerId, newTrack) => {
    const senders = sendersRef.current.get(peerId);
    if (!senders || !newTrack) {
      console.warn(`[RTC] Cannot replace track for ${peerId}`);
      return;
    }

    const sender =
      newTrack.kind === 'audio' ? senders.audioSender : senders.videoSender;
    if (!sender) {
      console.warn(`[RTC] No ${newTrack.kind} sender for ${peerId}`);
      return;
    }

    sender
      .replaceTrack(newTrack)
      .then(() => {
        console.log(`[RTC] Replaced ${newTrack.kind} track for ${peerId}`);
      })
      .catch((err) => {
        console.warn(`[RTC] Failed to replace ${newTrack.kind} track for ${peerId}:`, err);
      });
  }, []);

  /**
   * Get all active peer connections
   */
  const getAllPeerConnections = useCallback(() => {
    return Array.from(pcsRef.current.entries());
  }, []);

  /**
   * Close a specific peer connection
   */
  const closePeerConnection = useCallback((peerId) => {
    const pc = pcsRef.current.get(peerId);
    if (pc) {
      try {
        pc.close();
        console.log(`[RTC] Closed PeerConnection for ${peerId}`);
      } catch (err) {
        console.warn(`[RTC] Error closing PC for ${peerId}:`, err);
      }
    }
    pcsRef.current.delete(peerId);
    sendersRef.current.delete(peerId);
  }, []);

  /**
   * Close all peer connections
   */
  const closeAll = useCallback(() => {
    for (const [peerId, pc] of pcsRef.current.entries()) {
      try {
        pc.close();
      } catch (err) {
        console.warn(`[RTC] Error closing PC for ${peerId}:`, err);
      }
    }
    pcsRef.current.clear();
    sendersRef.current.clear();
    console.log('[RTC] Closed all PeerConnections');
  }, []);

  return {
    createPeerConnection,
    addLocalTracks,
    replaceTrack,
    getAllPeerConnections,
    closePeerConnection,
    closeAll,
    pcsRef, // Direct access to refs for advanced cases
    sendersRef,
  };
}
