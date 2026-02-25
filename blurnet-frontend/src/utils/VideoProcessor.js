export class VideoProcessor {
    constructor(options = {}) {
        // Accuracy Boost: Restored to 640x480. 
        // We use multi-threading on the backend to maintain speed.
        this.modelWidth = options.width || 640;
        this.modelHeight = options.height || 480;

        // Capture canvas for backend frames
        this.captureCanvas = document.createElement('canvas');
        this.captureCanvas.width = this.modelWidth;
        this.captureCanvas.height = this.modelHeight;
        this.captureCtx = this.captureCanvas.getContext('2d', { willReadFrequently: true });

        // NEW: Offscreen Blur Buffer for efficient regional blurring
        this.blurBuffer = document.createElement('canvas');
        this.blurBufferCtx = this.blurBuffer.getContext('2d');

        // persistence storage
        this.blurRegions = [];
        this.persistenceBuffer = [];

        // Anti-Flutter/Lockdown: Shield life counter (in frames)
        this.shieldLife = 0;
        this.maxShieldLife = 10;

        // Lockdown Timer (in milliseconds) - Re-introduced for safety
        this.lockdownUntil = 0;
        this.lockdownDuration = 5000;

        // Sentinel Engine: Temporal Smoothing (EMA)
        this.smoothedRegions = [];
        this.smoothingFactor = 0.5; // Optimized for 30fps

        this.video = null;
        this.canvas = null;
        this.animationId = null;
    }

    // This is called by VideoCall when WebSocket receives message
    setRegions(regions, maxScore = 0) {
        this.blurRegions = regions || [];

        // HYBRID TRIGGER: Any detection causes immediate full-frame lockdown
        if (this.blurRegions.length > 0) {
            this.lockdownUntil = Date.now() + this.lockdownDuration;
            this.shieldLife = this.maxShieldLife;
        }
    }

    // Helper to extract frame for backend
    extractFrame(videoElement) {
        if (!videoElement || videoElement.readyState < 2) return null;
        this.captureCtx.drawImage(videoElement, 0, 0, this.modelWidth, this.modelHeight);
        // Optimization: Reduced quality to 0.4 (40%) to save bandwidth and encoding time
        return this.captureCanvas.toDataURL('image/jpeg', 0.4);
    }

    // STEP 3 — Start render loop after video starts
    startRenderLoop(video, canvas) {
        this.video = video;
        this.canvas = canvas;

        // Sync buffer sizes
        this.blurBuffer.width = canvas.width;
        this.blurBuffer.height = canvas.height;

        if (this.animationId) return;

        // Ensure we start when metadata is ready
        if (video.readyState >= 1) {
            this.render();
        } else {
            video.onloadedmetadata = () => {
                this.render();
            };
        }
    }

    stopRenderLoop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    // STEP 2 — Create continuous render loop
    render() {
        if (!this.video || !this.canvas || this.video.readyState < 2) {
            this.animationId = requestAnimationFrame(this.render.bind(this));
            return;
        }

        const ctx = this.canvas.getContext("2d", { alpha: false });
        const { width, height } = this.canvas;

        // 1. Calculate Lockdown State (Full Frame Blur)
        const isInLockdown = Date.now() < this.lockdownUntil;

        if (isInLockdown || this.shieldLife > 0) {
            // Strong Lockdown Blur: 30px for total privacy when nudity is seen
            ctx.filter = "blur(30px)";
        } else {
            ctx.filter = "none";
        }

        // 2. Draw Video Frame (Subject to Lockdown filter)
        ctx.drawImage(this.video, 0, 0, width, height);

        // 3. Selective Regional Blur (Secondary Layer of Safety)
        // We do this even during lockdown for redundant masking of the source
        const hasRegions = this.blurRegions.length > 0 || this.smoothedRegions.length > 0;

        if (hasRegions) {
            const bCtx = this.blurBufferCtx;
            bCtx.filter = "blur(40px)"; // Extra high-intensity for the specific regions
            bCtx.drawImage(this.video, 0, 0, width, height);

            const backendToVideoX = this.video.videoWidth / this.modelWidth;
            const backendToVideoY = this.video.videoHeight / this.modelHeight;
            const scaleX = width / this.video.videoWidth;
            const scaleY = height / this.video.videoHeight;

            if (this.blurRegions.length > 0) {
                this.persistenceBuffer = this.blurRegions.map(r => ({ ...r, life: 10 }));
            }

            this.persistenceBuffer.forEach(region => {
                let sr = this.smoothedRegions.find(s => s.label === region.label);
                if (!sr) {
                    sr = { ...region, life: region.life };
                    this.smoothedRegions.push(sr);
                } else {
                    sr.x = sr.x + this.smoothingFactor * (region.x - sr.x);
                    sr.y = sr.y + this.smoothingFactor * (region.y - sr.y);
                    sr.width = sr.width + this.smoothingFactor * (region.width - sr.width);
                    sr.height = sr.height + this.smoothingFactor * (region.height - sr.height);
                    sr.life = region.life;
                }
            });

            this.smoothedRegions.forEach((region) => {
                const sx_raw = region.x * backendToVideoX;
                const sy_raw = region.y * backendToVideoY;
                const sw_raw = region.width * backendToVideoX;
                const sh_raw = region.height * backendToVideoY;

                const x = sx_raw * scaleX;
                const y = sy_raw * scaleY;
                const w = sw_raw * scaleX;
                const h = sh_raw * scaleY;

                // Overlay the surgical blur patch
                ctx.filter = "none"; // Reset filter for the patch draw
                ctx.drawImage(this.blurBuffer, x, y, w, h, x, y, w, h);

                // Professional debug indicator
                ctx.strokeStyle = "rgba(255, 0, 0, 0.4)";
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, w, h);

                region.life -= 1;
            });

            this.smoothedRegions = this.smoothedRegions.filter(r => r.life > 0);
            this.persistenceBuffer = this.persistenceBuffer.filter(r => r.life > 0);
        }

        if (this.shieldLife > 0) this.shieldLife -= 1;

        this.animationId = requestAnimationFrame(this.render.bind(this));
    }
}
