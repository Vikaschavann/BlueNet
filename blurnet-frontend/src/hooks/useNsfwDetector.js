/**
 * useNsfwDetector — Client-side NSFW detection using TensorFlow.js + nsfwjs
 *
 * This runs entirely in the browser as a FAST first-pass detector.
 * It catches explicit content (including phones showing porn) within ~50ms,
 * while the backend pipeline handles deeper analysis.
 *
 * Usage:
 *   const { prediction, isLoading } = useNsfwDetector(videoRef, { enabled: true, interval: 300 });
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as nsfwjs from 'nsfwjs';

// Singleton model — load once across all component mounts
let modelPromise = null;
let loadedModel = null;

export function getNsfwModel() {
  if (loadedModel) return Promise.resolve(loadedModel);
  if (!modelPromise) {
    modelPromise = nsfwjs.load('MobileNetV2Mid').then(m => {
      loadedModel = m;
      console.log('[NSFW.js] Model loaded (MobileNetV2Mid)');
      return m;
    }).catch(err => {
      console.error('[NSFW.js] Model load failed:', err);
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

export function useNsfwDetector(videoRef, options = {}) {
  const { enabled = true, interval = 300, onUnsafe = null } = options;
  const [isLoading, setIsLoading] = useState(true);
  const modelRef = useRef(null);
  const timerRef = useRef(null);
  const canvasRef = useRef(null);

  // Load model once
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setIsLoading(true);

    getNsfwModel().then(model => {
      if (!cancelled) {
        modelRef.current = model;
        setIsLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [enabled]);

  // Classification loop
  const classify = useCallback(async () => {
    const video = videoRef?.current;
    const model = modelRef.current;
    if (!video || !model || video.readyState < 2) return;

    try {
      // Create a small canvas for classification (224x224 is what the model expects)
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
        canvasRef.current.width = 224;
        canvasRef.current.height = 224;
      }
      const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 224, 224);

      // Classify
      const predictions = await model.classify(canvasRef.current, 5);

      // Find the top NSFW categories
      const nsfwCategories = ['Porn', 'Sexy', 'Hentai'];
      const nsfwPreds = predictions.filter(p => nsfwCategories.includes(p.className));
      const topNsfw = nsfwPreds.reduce((max, p) => p.probability > max.probability ? p : max, { className: 'None', probability: 0 });
      const topPred = predictions.reduce((max, p) => p.probability > max.probability ? p : max, predictions[0]);

      const result = {
        top: topPred,
        nsfwScore: topNsfw.probability,
        isUnsafe: topNsfw.probability > 0.45,
        category: topNsfw.className,
        all: predictions
      };

      // Callback for external handling ONLY
      if (result.isUnsafe && onUnsafe) {
        onUnsafe(result);
      }

    } catch (err) {
      // Silently handle — don't crash the loop
      console.debug('[NSFW.js] Classification error:', err.message);
    }
  }, [videoRef, onUnsafe]);

  // Start/stop classification loop
  useEffect(() => {
    if (!enabled || isLoading) return;

    const loop = () => {
      classify();
      timerRef.current = setTimeout(loop, interval);
    };
    loop();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, isLoading, interval, classify]);

  return { isLoading };
}
