const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
};

/**
 * Create a receive-only RTCPeerConnection (no tracks added initially)
 * 
 * This enables "join without media" mode:
 * - User can join and view others WITHOUT granting permissions
 * - Tracks added later via addTrack/replaceTrack after getUserMedia
 * 
 * @param {Object} config
 * @param {RTCConfiguration} config.rtcConfig - ICE servers config
 * @param {Function} config.onIceCandidate - Called when ice candidate generated
 * @param {Function} config.onTrack - Called when remote track received
 * @returns {RTCPeerConnection}
 */
export function createPeerConnection({ 
  rtcConfig = DEFAULT_RTC_CONFIG, 
  onIceCandidate, 
  onTrack 
}) {
  const pc = new RTCPeerConnection(rtcConfig);
  
  pc.onicecandidate = (e) => {
    if (e.candidate && onIceCandidate) {
      onIceCandidate(e.candidate);
    }
  };
  
  pc.ontrack = (e) => {
    if (onTrack) {
      onTrack(e);
    }
  };
  
  pc.onconnectionstatechange = () => {
    console.log('[RTC] Connection state:', pc.connectionState);
  };
  
  return pc;
}

/**
 * Add local audio track to existing PC
 * Call this after getUserMedia({ audio: true })
 * 
 * @param {RTCPeerConnection} pc
 * @param {MediaStream} stream - Must contain audio track
 * @returns {RTCRtpSender} - The audio sender, or null if no audio track
 */
export function addAudioTrack(pc, stream) {
  if (!pc || !stream) return null;
  
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    console.warn('[RTC] No audio track in stream');
    return null;
  }
  
  const sender = pc.addTrack(audioTrack, stream);
  console.log('[RTC] Added audio track to PC');
  return sender;
}

/**
 * Add local video track to existing PC
 * Call this after getUserMedia({ video: true })
 * 
 * @param {RTCPeerConnection} pc
 * @param {MediaStream} stream - Must contain video track
 * @returns {RTCRtpSender} - The video sender, or null if no video track
 */
export function addVideoTrack(pc, stream) {
  if (!pc || !stream) return null;
  
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    console.warn('[RTC] No video track in stream');
    return null;
  }
  
  const sender = pc.addTrack(videoTrack, stream);
  console.log('[RTC] Added video track to PC');
  return sender;
}

/**
 * Add full media (audio + video) to existing PC
 * 
 * @param {RTCPeerConnection} pc
 * @param {MediaStream} stream
 * @returns {Object} - { audioSender, videoSender }
 */
export function addFullMedia(pc, stream) {
  if (!pc || !stream) return { audioSender: null, videoSender: null };
  
  const audioSender = addAudioTrack(pc, stream);
  const videoSender = addVideoTrack(pc, stream);
  
  return { audioSender, videoSender };
}

/**
 * Replace an existing track on a sender
 * Use for camera toggle, mic mute via track.enabled, or screen share
 * 
 * @param {RTCRtpSender} sender
 * @param {MediaStreamTrack} newTrack - Use null to remove track
 * @returns {Promise<void>}
 */
export async function replaceTrackOnSender(sender, newTrack) {
  if (!sender) {
    console.warn('[RTC] No sender provided');
    return;
  }
  
  try {
    await sender.replaceTrack(newTrack);
    console.log('[RTC] Track replaced successfully');
  } catch (err) {
    console.error('[RTC] Failed to replace track:', err);
    throw err;
  }
}

export async function ensureOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return pc.localDescription;
}

