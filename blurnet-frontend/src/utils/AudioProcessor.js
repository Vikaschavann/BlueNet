export class AudioProcessor {
    constructor(onChunk) {
        this.onChunk = onChunk;
        this.originalStream = null;
        this.audioOnlyStream = null;
        this.isMuted = false;
        this.chunkDuration = 2000; // 2 seconds
        this.mediaRecorder = null;
        this.supportedMimeType = null;
    }

    getSupportedMimeType() {
        // Prioritized list as requested
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
                console.log(`[AUDIO] Detected supported MIME type: ${type}`);
                return type;
            }
        }
        return ''; // Final fallback
    }

    async start(stream) {
        try {
            console.log('[AUDIO] Attempting to start MediaRecorder...');
            this.originalStream = stream;

            // 1. Extract only audio tracks and create a new MediaStream
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                throw new Error('No audio tracks found in the provided stream.');
            }

            // Ensure the track is active/live
            const audioTrack = audioTracks[0];
            if (audioTrack.readyState !== 'live' || !audioTrack.enabled) {
                throw new Error(`Audio track is not ready for recording (State: ${audioTrack.readyState}, Enabled: ${audioTrack.enabled})`);
            }

            this.audioOnlyStream = new MediaStream([audioTrack]);
            console.log('[AUDIO] Created audio-only MediaStream for recording');

            // 2. Detect the best supported MIME type
            this.supportedMimeType = this.getSupportedMimeType();
            const options = this.supportedMimeType ? { mimeType: this.supportedMimeType } : {};

            // 3. Initialize MediaRecorder with audio-only stream
            this.mediaRecorder = new MediaRecorder(this.audioOnlyStream, options);

            this.mediaRecorder.ondataavailable = async (event) => {
                if (event.data.size > 0 && this.onChunk) {
                    try {
                        // Use the detected MIME type or the blob's native type
                        const blobType = this.supportedMimeType || event.data.type;
                        const blob = new Blob([event.data], { type: blobType });
                        const base64 = await this.blobToBase64(blob);
                        this.onChunk(base64);
                    } catch (err) {
                        console.error('[AUDIO] Error in chunk processing:', err);
                    }
                }
            };

            this.mediaRecorder.onerror = (event) => {
                console.error('[AUDIO] MediaRecorder runtime error:', event.error);
            };

            this.mediaRecorder.onstop = () => {
                console.log('[AUDIO] MediaRecorder successfully stopped');
            };

            // 4. Start recording with 2-second time slices
            this.mediaRecorder.start(this.chunkDuration);
            console.log(`[AUDIO] MediaRecorder started (${this.supportedMimeType || 'default'}) at ${this.chunkDuration}ms intervals`);

        } catch (error) {
            console.error('[AUDIO] CRITICAL: Failed to execute start on MediaRecorder:', error.message);
            throw error;
        }
    }

    stop() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try {
                this.mediaRecorder.stop();
            } catch (err) {
                console.error('[AUDIO] Error during stop:', err);
            }
        }
        // Cleanup streams
        if (this.audioOnlyStream) {
            this.audioOnlyStream.getTracks().forEach(track => track.stop());
        }
    }

    setMute(muted) {
        this.isMuted = muted;
        // Mute both original and recording streams
        const streams = [this.originalStream, this.audioOnlyStream];
        streams.forEach(s => {
            if (s) {
                s.getAudioTracks().forEach(track => {
                    track.enabled = !muted;
                });
            }
        });
        console.log(`[AUDIO] Mute status set to: ${muted}`);
    }

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (reader.result) {
                    const base64 = reader.result.split(',')[1];
                    resolve(base64);
                } else {
                    reject(new Error('FileReader result was null'));
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }
}
