/**
 * useObjectDetector — Client-side object detection using TensorFlow.js + coco-ssd
 *
 * Runs locally to detect objects in the webcam feed.
 * Specifically useful for identifying "cell phone" objects.
 *
 * Usage:
 *   const { detections, isLoading } = useObjectDetector(videoRef, { enabled: true, interval: 500 });
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

// Singleton model — load once across all component mounts
let modelPromise = null;
let loadedModel = null;

function getModel() {
  if (loadedModel) return Promise.resolve(loadedModel);
  if (!modelPromise) {
    modelPromise = cocoSsd.load().then(m => {
      loadedModel = m;
      console.log('[COCO-SSD] Model loaded successfully');
      return m;
    }).catch(err => {
      console.error('[COCO-SSD] Model load failed:', err);
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

export function useObjectDetector(videoRef, options = {}) {
  const { enabled = true, interval = 500, targetClass = 'cell phone', onCrops, onDetect } = options;
  const [isLoading, setIsLoading] = useState(true);
  const modelRef = useRef(null);
  const timerRef = useRef(null);

  // Load model once
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setIsLoading(true);

    getModel().then(model => {
      if (!cancelled) {
        modelRef.current = model;
        setIsLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [enabled]);

  const cropCanvasRef = useRef(null);
  const inferenceCanvasRef = useRef(null);

  // Classification loop
  const detect = useCallback(async () => {
    const video = videoRef?.current;
    const model = modelRef.current;
    if (!video || !model || video.readyState < 2) return;

    try {
      // 1. Resize into 416x416 inference canvas for MUCH faster YOLO detection
      if (!inferenceCanvasRef.current) {
        inferenceCanvasRef.current = document.createElement('canvas');
        inferenceCanvasRef.current.width = 416; // Ideal YOLO size
        inferenceCanvasRef.current.height = 416;
      }
      const infCanvas = inferenceCanvasRef.current;
      const infCtx = infCanvas.getContext('2d', { willReadFrequently: true });
      infCtx.drawImage(video, 0, 0, 416, 416);

      const predictions = await model.detect(infCanvas);
      
      const targetDetections = targetClass 
        ? predictions.filter(p => p.class === targetClass)
        : predictions;

      // 2. Scale up bounding boxes to native video resolution
      const scaleX = video.videoWidth / 416;
      const scaleY = video.videoHeight / 416;

      const crops = [];
      if (targetDetections.length > 0) {
        if (!cropCanvasRef.current) {
          cropCanvasRef.current = document.createElement('canvas');
        }
        const ctx = cropCanvasRef.current.getContext('2d', { willReadFrequently: true });
        
        targetDetections.forEach(d => {
          let [x, y, w, h] = d.bbox;
          x *= scaleX;
          y *= scaleY;
          w *= scaleX;
          h *= scaleY;
          
          // Re-assign accurate upscale bounds to the object
          d.bbox = [x, y, w, h];
          
          // Ensure bounds are safe
          let safeX = Math.max(0, x);
          let safeY = Math.max(0, y);
          let safeW = Math.min(video.videoWidth - safeX, w);
          let safeH = Math.min(video.videoHeight - safeY, h);
          
          if (safeW > 0 && safeH > 0) {
            cropCanvasRef.current.width = safeW;
            cropCanvasRef.current.height = safeH;
            ctx.drawImage(video, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);
            const tensor = tf.browser.fromPixels(cropCanvasRef.current);
            crops.push({
              bbox: d.bbox,
              class: d.class,
              score: d.score,
              tensor: tensor
            });
          }
        });
      }

      // Notify overlay without triggering massive Room.jsx layout re-renders
      if (onDetect) onDetect(targetDetections);

      if (onCrops && crops.length > 0) {
        onCrops(crops); 
      } else {
        crops.forEach(c => { if (c.tensor) c.tensor.dispose(); });
      }

    } catch (err) {
      console.debug('[COCO-SSD] Detection error:', err.message);
    }
  }, [videoRef, targetClass, onCrops, onDetect]);

  // Start/stop classification loop
  useEffect(() => {
    if (!enabled || isLoading) return;

    // Use setTimeout equivalent to requestAnimationFrame but honoring interval natively
    const loop = () => {
      detect();
      timerRef.current = setTimeout(loop, interval);
    };
    loop();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, isLoading, interval, detect]);

  return { isLoading };
}
