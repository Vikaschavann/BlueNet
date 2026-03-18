const DEFAULT_RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export function createPeerConnection({ rtcConfig = DEFAULT_RTC_CONFIG, onIceCandidate, onTrack }) {
  const pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = (e) => {
    if (e.candidate) onIceCandidate(e.candidate);
  };
  pc.ontrack = (e) => onTrack(e);
  return pc;
}

export async function ensureOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return pc.localDescription;
}

