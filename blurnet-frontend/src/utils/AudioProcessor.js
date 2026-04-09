export class AudioProcessor {
    constructor(onChunk) {
        this.onChunk = onChunk;
        
        // Web Audio API Elements
        this.audioContext = null;
        this.sourceNode = null;
        this.gainNode = null;
        this.destinationNode = null;
        
        this.originalStream = null;
        this.isMuted = false;
        
        this.mediaRecorder = null;
        this.chunkDuration = 2000;
        this.supportedMimeType = null;
    }

    getSupportedMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus',
            'audio/aac',
            'audio/wav'
        ];
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return '';
    }

    async start(stream) {
        try {
            console.log('[AUDIO] Initializing AudioContext moderation proxy...');
            this.originalStream = stream;

            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                throw new Error('No audio tracks found relative to raw stream.');
            }

            // 1. Initialize Web Audio API (Must be done safely after user gesture)
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // 2. Map Original Stream -> GainNode -> Destination (for WebRTC outbound)
            this.sourceNode = this.audioContext.createMediaStreamSource(this.originalStream);
            this.gainNode = this.audioContext.createGain();
            this.destinationNode = this.audioContext.createMediaStreamDestination();
            
            // Wire the safe outbound pipeline
            this.sourceNode.connect(this.gainNode);
            this.gainNode.connect(this.destinationNode);
            
            // Make sure the audio context natively resumes
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            // 3. Script processor loop to still feed WebSockets via chunk collector
            this.supportedMimeType = this.getSupportedMimeType();
            const options = this.supportedMimeType ? { mimeType: this.supportedMimeType } : {};
            
            // We use the raw stream to feed AI, so it can monitor toxicity even while the peer is muted outgoing
            this.mediaRecorder = new MediaRecorder(this.originalStream, options);

            this.mediaRecorder.ondataavailable = async (event) => {
                if (event.data.size > 0 && this.onChunk) {
                    try {
                        const blobType = this.supportedMimeType || event.data.type;
                        const blob = new Blob([event.data], { type: blobType });
                        const base64 = await this.blobToBase64(blob);
                        this.onChunk(base64);
                    } catch (err) {
                        console.error('[AUDIO] Error in chunk processing:', err);
                    }
                }
            };
            this.mediaRecorder.start(this.chunkDuration);

            console.log('[AUDIO] Audio Moderation Pipeline wired successfully.');
        } catch (error) {
            console.error('[AUDIO] CRITICAL Error initializing WebAudio:', error);
            throw error;
        }
    }

    /**
     * EXTRACT PROXY STREAM
     * returns a cloned safe AudioTrack driven entirely by the GainNode
     */
    getProcessedStream() {
        if (!this.destinationNode) {
            console.warn('[AUDIO] Called getProcessedStream before constraints were built.');
            return null;
        }
        return this.destinationNode.stream;
    }

    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        
        this.originalStream = null;
    }

    setMute(muted) {
        this.isMuted = muted;
        if (this.gainNode) {
            // Drop Outbound Gain completely so Remote sees audio-silence
            // but the AI WebSocket continues to ingest audio via MediaRecorder!
            this.gainNode.gain.setTargetAtTime(muted ? 0 : 1, this.audioContext.currentTime, 0.05);
        }
        console.log(`[AUDIO] Outbound Toxicity Muted via GainNode: ${muted}`);
    }

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (reader.result) {
                    resolve(reader.result.split(',')[1]);
                } else reject(new Error('FileReader result null'));
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }
}
