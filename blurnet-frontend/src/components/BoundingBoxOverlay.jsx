import React, { useRef, useEffect } from 'react';

/**
 * Renders bounding boxes over a video element.
 * Scales coordinates dynamically to match responsive layout.
 */
export default function BoundingBoxOverlay({ detectionsRef, videoRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let animationId;
    
    function renderLoop() {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const detections = detectionsRef?.current || [];
      
      if (!canvas || !video || detections.length === 0) {
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        animationId = requestAnimationFrame(renderLoop);
        return;
      }

      // Sync canvas size to visual video size purely
      const rect = video.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Calculate scale between actual video resolution and CSS size
      const scaleX = rect.width / video.videoWidth;
      const scaleY = rect.height / video.videoHeight;

      detections.forEach(d => {
        let [x, y, w, h] = d.bbox;
        
        // Apply aspect ratio scale
        x *= scaleX;
        y *= scaleY;
        w *= scaleX;
        h *= scaleY;

        // Draw box
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);

        // Draw label
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(x, y - 24, w, 24);
        
        ctx.fillStyle = '#000000';
        ctx.font = '14px Arial';
        ctx.fontWeight = 'bold';
        ctx.fillText(`${d.class} (${Math.round(d.score * 100)}%)`, x + 4, y - 6);
      });
      
      animationId = requestAnimationFrame(renderLoop);
    }
    
    renderLoop();
    
    return () => cancelAnimationFrame(animationId);
  }, [detectionsRef, videoRef]);

  return (
    <canvas 
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        objectFit: 'cover'
      }}
    />
  );
}
