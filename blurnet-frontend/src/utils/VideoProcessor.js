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

    // This is called by VideoCall when WebSocket receives message
    setRegions(regions, maxScore = 0, nsfwScore = 0.0, action = "safe") {
        
        // Ensure regions is an array
        this.blurRegions = regions || [];
        
        // Hysteresis & Smoothing Flags setup
        this.scoreHistory.push(Math.max(maxScore, nsfwScore));
        if (this.scoreHistory.length > 5) this.scoreHistory.shift();

        const safeCount = this.scoreHistory.filter(s => s < 0.5).length;

        // NEW DECISION LOGIC BASED ON BACKEND RISK ENGINE
        if (action === "block" || action === "blur" && this.blurRegions.length === 0) {
            this.isGloballyBlurred = true;
            this.lastUnsafeTime = Date.now();
            this.lockdownUntil = Date.now() + (action === "block" ? 1500 : 800); 
            this.shieldLife = action === "block" ? 15 : 5;
        } else if (this.blurRegions.length > 0 || action === "blur") {
            // Apply region blur normally or if action is blur but we have regions
            if (this.isGloballyBlurred && Date.now() - this.lastUnsafeTime > 1500 && safeCount >= 3) {
                 this.isGloballyBlurred = false;
            }
        } else {
            // No blur needed, cleanly reset
            if (Date.now() - this.lastUnsafeTime > 1500 && safeCount >= 3) {
                this.isGloballyBlurred = false;
                this.blurRegions = [];
                this.persistenceBuffer = [];
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
           targetHeight = 320;
           targetWidth = Math.round(320 * ratio);
        }
        
        if (this.captureCanvas.width !== targetWidth || this.captureCanvas.height !== targetHeight) {
            this.captureCanvas.width = targetWidth;
            this.captureCanvas.height = targetHeight;
        }

        this.captureCtx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);
        
        // Optimization: Reduced quality intelligently
        return this.captureCanvas.toDataURL('image/jpeg', sourceType === "screen" ? 0.3 : 0.4);
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
            clearTimeout(this.animationId);
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

        // Use stable timeout to strictly bypass requestAnimationFrame background pausing
        // 33ms ~= 30fps
        this.animationId = setTimeout(() => this.renderLoop(), 33);
    }

    renderCore() {
        if (!this.video || !this.canvas || this.video.readyState < 2) {
            return;
        }

        const ctx = this.canvas.getContext("2d", { alpha: false });
        const { width, height } = this.canvas;
        
        // 0. Ensure canvas resets every frame cleanly
        ctx.clearRect(0, 0, width, height);

        // 1. Calculate Lockdown State (Full Frame Blur)
        const isInLockdown = Date.now() < this.lockdownUntil || this.isGloballyBlurred;

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
                // Expand handling to support ALL multiple regions uniquely by index
                this.persistenceBuffer = this.blurRegions.map((r, i) => ({ ...r, id: `${r.label}_${i}`, life: 10 }));
            }

            this.persistenceBuffer.forEach(region => {
                // Fix Region Overwrite: Use unique .id instead of .label identical matches
                let sr = this.smoothedRegions.find(s => s.id === region.id);
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

                let x = sx_raw * scaleX;
                let y = sy_raw * scaleY;
                let w = sw_raw * scaleX;
                let h = sh_raw * scaleY;

                // Expand each region significantly (padding 50-80px overlay) to ensure 
                // absolutely no unblurred slivers escape between fast rendering updates
                x -= 40;
                y -= 40;
                w += 80;
                h += 80;

                // Normalize coordinates to stay safely inside canvas dimensions
                x = Math.max(0, x);
                y = Math.max(0, y);
                w = Math.min(width - x, w);
                h = Math.min(height - y, h);

                // Overlay the surgical blur patch seamlessly
                ctx.filter = "none"; // Reset filter for the patch draw
                ctx.drawImage(this.blurBuffer, x, y, w, h, x, y, w, h);

                // Professional debug indicator
                ctx.strokeStyle = "rgba(255, 0, 0, 0.4)";
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, w, h);

                region.life -= 1;
            });

            // FIX CANVAS PROCESSING LOOP: Decay the persistence buffer too!
            this.persistenceBuffer.forEach(region => {
                region.life -= 1; 
            });

            this.smoothedRegions = this.smoothedRegions.filter(r => r.life > 0);
            this.persistenceBuffer = this.persistenceBuffer.filter(r => r.life > 0);
        }

        if (this.shieldLife > 0) this.shieldLife -= 1;
    }
}
