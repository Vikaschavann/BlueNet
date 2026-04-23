export class VideoProcessor {
    constructor(options = {}) {
        // Higher resolution needed to detect explicit content on phone screens held up to camera
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
        this.smoothingFactor = 0.85; // Faster tracking to instantly mask sudden movements

        // Hysteresis & Smoothing Configuration
        this.scoreHistory = [];
        this.isGloballyBlurred = false;
        this.lastUnsafeTime = 0;

        // Backpressure and Failsafe Flags
        this.isBackendProcessing = false;
        this.lastFrameSentAt = 0;

        this.video = null;
        this.canvas = null;
        this.animationId = null;
    }

    notifyFrameSent() {
        this.isBackendProcessing = true;
        this.lastFrameSentAt = Date.now();
    }

    notifyFrameReceived() {
        this.isBackendProcessing = false;
    }

    triggerFailsafeBlur() {
        console.warn("[VideoProcessor] Triggering mandatory failsafe lockdown due to UI/latency threshold.");
        this.shieldLife = 10;
        this.lockdownUntil = Date.now() + 1000;
        this.isGloballyBlurred = true;
        this.isBackendProcessing = false; // Release the lock defensively
        
        // Ensure immediate draw if locked
        this.blurRegions = [];
        this.persistenceBuffer = [];
        this.smoothedRegions = [];
    }

    triggerGlobalBlur(durationMs = 800, severity = 'blur') {
        this.isGloballyBlurred = true;
        this.lastUnsafeTime = Date.now();
        this.lockdownUntil = Date.now() + durationMs;
        this.shieldLife = severity === 'block' ? 15 : 5;
    }

    addSurgicalRegion(region, lifeFrames = 10) {
        // Direct injection into the rendering decay buffer
        const id = `SURGICAL_${Date.now()}_${Math.random()}`;
        const sr = { ...region, id, life: lifeFrames };
        this.smoothedRegions.push(sr);
    }

    // This is called by VideoCall when WebSocket receives message (backend pipeline)
    setRegions(regions, maxScore = 0, nsfwScore = 0.0, action = "safe") {
        
        // Hysteresis & Smoothing Flags setup
        this.scoreHistory.push(Math.max(maxScore, nsfwScore));
        if (this.scoreHistory.length > 5) this.scoreHistory.shift();

        const safeCount = this.scoreHistory.filter(s => s < 0.5).length;
        const hasRegions = regions && regions.length > 0;

        if (hasRegions) {
            // We have precise regions — inject them into the processor cleanly without resetting global state
            regions.forEach((r, i) => {
                let sr = this.smoothedRegions.find(s => s.id === `${r.label}_BACKEND_${i}`);
                if (!sr) {
                    this.smoothedRegions.push({ ...r, id: `${r.label}_BACKEND_${i}`, life: 10 });
                } else {
                    sr.x = sr.x + this.smoothingFactor * (r.x - sr.x);
                    sr.y = sr.y + this.smoothingFactor * (r.y - sr.y);
                    sr.width = sr.width + this.smoothingFactor * (r.width - sr.width);
                    sr.height = sr.height + this.smoothingFactor * (r.height - sr.height);
                    sr.life = 10;
                }
            });
        } else if (action === "block") {
            this.triggerGlobalBlur(1500, 'block');
        } else if (action === "blur") {
            this.triggerGlobalBlur(800, 'blur');
        } else {
            // Safe — cleanly reset if enough safe history
            if (Date.now() - this.lastUnsafeTime > 1500 && safeCount >= 3) {
                this.isGloballyBlurred = false;
                this.smoothedRegions = [];
                this.lockdownUntil = 0;
                this.shieldLife = 0;
            }
        }
    }

    // Expose robust hysteresis state for UI alerts without flickering
    hasActiveBlur() {
        const isLocked = Date.now() < this.lockdownUntil || this.isGloballyBlurred || this.shieldLife > 0;
        const hasRegions = this.blurRegions.length > 0 || this.smoothedRegions.length > 0;
        return isLocked || hasRegions;
    }

    // Helper to extract frame for backend with dynamic sizing
    extractFrame(videoElement, sourceType = "webcam") {
        if (!videoElement || videoElement.readyState < 2) return null;
        
        let targetWidth = this.modelWidth;
        let targetHeight = this.modelHeight;
        
        // Dynamically shrink screenshare resolution heavily to preserve inference latencies
        if (sourceType === "screen") {
           const ratio = videoElement.videoWidth / videoElement.videoHeight;
           targetHeight = 240;
           targetWidth = Math.round(240 * ratio);
        }
        
        if (this.captureCanvas.width !== targetWidth || this.captureCanvas.height !== targetHeight) {
            this.captureCanvas.width = targetWidth;
            this.captureCanvas.height = targetHeight;
        }

        this.captureCtx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);
        
        // Higher JPEG quality to preserve detail on small embedded screens (phones held to camera)
        return this.captureCanvas.toDataURL('image/jpeg', sourceType === "screen" ? 0.35 : 0.55);
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
        this.isActive = true;
        this.isRenderingFrame = false;
        
        if (video.readyState >= 1) {
            this.renderLoop();
        } else {
            video.onloadedmetadata = () => {
                this.renderLoop();
            };
        }
    }

    stopRenderLoop() {
        this.isActive = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    // STEP 2 — Create continuous background-survivable render loop
    async renderLoop() {
        if (!this.isActive) return;

        if (!this.isRenderingFrame) {
             this.isRenderingFrame = true;
             try {
                 this.renderCore();
             } catch (err) {
                 console.error("[VideoProcessor] Loop error:", err);
             }
             this.isRenderingFrame = false;
        }

        // Use native display refresh rates to eradicate visual stuttering 
        this.animationId = requestAnimationFrame(() => this.renderLoop());
    }

    renderCore() {
        if (!this.video || !this.canvas || this.video.readyState < 2) {
            return;
        }

        const ctx = this.canvas.getContext("2d", { alpha: false });
        const { width, height } = this.canvas;
        
        // 0. Ensure canvas resets every frame cleanly
        ctx.clearRect(0, 0, width, height);

        // 1. Check Lockdown State (Full Frame Blur — only when NO regions exist)
        const isInLockdown = Date.now() < this.lockdownUntil || this.isGloballyBlurred;

        if ((isInLockdown || this.shieldLife > 0) && this.blurRegions.length === 0 && this.smoothedRegions.length === 0) {
            // Full-screen blur ONLY as fallback when no targeted regions exist
            ctx.filter = "blur(30px)";
        } else {
            ctx.filter = "none";
        }

        // 2. Draw Video Frame (clean or full-blur depending on lockdown)
        ctx.drawImage(this.video, 0, 0, width, height);

        // 3. Selective Regional Blur (Secondary Layer of Safety)
        // We do this even during lockdown for redundant masking of the source
        const hasRegions = this.smoothedRegions.length > 0;

        if (hasRegions) {
            const bCtx = this.blurBufferCtx;
            bCtx.filter = "blur(40px)"; // Extra high-intensity for the specific regions
            bCtx.drawImage(this.video, 0, 0, width, height);

            const backendToVideoX = this.video.videoWidth / this.modelWidth;
            const backendToVideoY = this.video.videoHeight / this.modelHeight;
            const scaleX = width / this.video.videoWidth;
            const scaleY = height / this.video.videoHeight;

            this.smoothedRegions.forEach((region) => {
                const sx_raw = region.x * backendToVideoX;
                const sy_raw = region.y * backendToVideoY;
                const sw_raw = region.width * backendToVideoX;
                const sh_raw = region.height * backendToVideoY;

                let x = sx_raw * scaleX;
                let y = sy_raw * scaleY;
                let w = sw_raw * scaleX;
                let h = sh_raw * scaleY;

                // Proportional padding (15% of region size) instead of fixed pixels
                const padX = w * 0.15;
                const padY = h * 0.15;
                x -= padX;
                y -= padY;
                w += padX * 2;
                h += padY * 2;

                // Normalize coordinates to stay safely inside canvas dimensions
                x = Math.max(0, x);
                y = Math.max(0, y);
                w = Math.min(width - x, w);
                h = Math.min(height - y, h);

                // Overlay the surgical blur patch seamlessly
                ctx.filter = "none";
                ctx.drawImage(this.blurBuffer, x, y, w, h, x, y, w, h);

                region.life -= 1;
            });

            this.smoothedRegions = this.smoothedRegions.filter(r => r.life > 0);
        }

        if (this.shieldLife > 0) this.shieldLife -= 1;
    }
}
