import cv2
import base64
import numpy as np
import os
from models.nudity_model import NudityModel
from models.nsfw_model import NSFWModel
from PIL import Image

class VideoModerator:
    def __init__(self, nudity_model: NudityModel, nsfw_model: NSFWModel = None):
        self.nudity_model = nudity_model
        self.nsfw_model = nsfw_model

    def moderate_frame(self, base64_frame):
        """
        Processes a single frame and returns moderation result.
        """
        # STEP 1: Safely decode frame
        try:
            if isinstance(base64_frame, str):
                if "data:image" in base64_frame and ";base64," in base64_frame:
                    base64_frame = base64_frame.split(";base64,")[1]
                elif "," in base64_frame:
                    base64_frame = base64_frame.split(",")[1]
            
            img_bytes = base64.b64decode(base64_frame)
            nparr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                raise ValueError("Could not decode image")
                
            # STEP 5: Debug log
            print("Frame received")
        except Exception as e:
            print(f"[ERROR] Frame decode failed: {e}")
            return {"unsafe": False, "regions": []}

        # FAST PATH: Skip heavy Sentinel Pipeline for real-time WebSocket MVP
        # This converts ~150ms latency per frame to ~2ms per frame on CPU.
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # STEP 2a: Multi-Label Inference (Detections)
        detections = self.nudity_model.detect(frame_rgb)
        
        # STEP 2b: Global Frame Inference (NSFW Classification)
        nsfw_score = 0.0
        if self.nsfw_model:
            try:
                pil_img = Image.fromarray(frame_rgb)
                nsfw_score = self.nsfw_model.predict(pil_img)
            except Exception as e:
                print(f"[NSFW Model Error] {e}")
                
        regions = []
        is_unsafe = False
        max_score = 0
        centroids = [] # List of (x, y) for clustering analysis

        # STEP 2c: Mobile Screen / Picture-in-Picture Detection (Texture Clustering)
        # Identifies smaller rectangular screens in the feed to specifically blur them
        if self.nsfw_model:
            try:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                edges = cv2.Canny(gray, 50, 150)
                dilated = cv2.dilate(edges, None, iterations=8)
                contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                
                img_h, img_w = frame.shape[:2]
                min_area = (img_w * img_h) * 0.05 
                
                valid_cnts = [c for c in contours if cv2.contourArea(c) > min_area]
                valid_cnts = sorted(valid_cnts, key=cv2.contourArea, reverse=True)[:3]
                
                for cnt in valid_cnts:
                    cx, cy, cw, ch = cv2.boundingRect(cnt)
                    px, py = int(cw * 0.1), int(ch * 0.1)
                    x1, y1 = max(0, cx - px), max(0, cy - py)
                    x2, y2 = min(img_w, cx + cw + px), min(img_h, cy + ch + py)
                    
                    crop_rgb = frame_rgb[y1:y2, x1:x2]
                    crop_pil = Image.fromarray(crop_rgb)
                    crop_score = self.nsfw_model.predict(crop_pil)
                    
                    if crop_score > 0.40:
                        is_unsafe = True
                        max_score = max(max_score, crop_score)
                        regions.append({
                            "x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1,
                            "label": "EXPLICIT_SCREEN", "confidence": crop_score
                        })
                        print(f"[SENTINEL] Mobile Screen Blocked! Crop Score: {crop_score:.3f}")
            except Exception as e:
                print(f"[Screen Detect Error] {e}")
        
        target_labels = {
            'EXPOSED_BREAST_F', 'EXPOSED_GENITALIA_F', 'EXPOSED_GENITALIA_M', 
            'EXPOSED_BUTTOCKS', 'EXPOSED_ANUS',
            'FEMALE_BREAST_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 
            'ANUS_EXPOSED', 'BUTTOCKS_EXPOSED', 'MALE_BREAST_EXPOSED',
            'FEMALE_BREAST', 'MALE_GENITALIA', 'FEMALE_GENITALIA', 'BUTTOCKS',
            'EXPOSED_BELLY', 'EXPOSED_ARMPITS',
            'FEMALE_GENITALIA_COVERED', 'FEMALE_BREAST_COVERED', 'BUTTOCKS_COVERED', 'ANUS_COVERED'
        }
        
        for d in detections:
            try:
                label = d.get('label') or d.get('class')
                score = float(d['score'])
                max_score = max(max_score, score)
                
                # Dynamic Thresholding: Extra sensitive to catch content shown via small mobile screens
                base_threshold = 0.08 if "EXPOSED" in label else 0.15
                
                if label in target_labels and score > base_threshold:
                    is_unsafe = True
                    box = d['box']
                    x, y, val3, val4 = box
                    
                    # Normalize box [x, y, w, h]
                    if val3 > x and val4 > y and (val3 - x < 10 or val4 - y < 10): w, h = val3, val4
                    elif val3 > x and val4 > y: w, h = val3 - x, val4 - y
                    else: w, h = val3, val4

                    # Expansion with Contextual Intelligence
                    expansion = 0.55 if "COVERED" in label else 0.45
                    
                    # ENHANCEMENT: Minimum absolute padding (40px) to ensure small detections 
                    # (like a phone screen held up to the camera) are fully covered by the blur patch
                    pw = max(40, w * expansion)
                    ph = max(40, h * expansion)
                    
                    regions.append({
                        "x": int(max(0, x - pw/2)),
                        "y": int(max(0, y - ph/2)),
                        "width": int(w + pw),
                        "height": int(h + ph),
                        "label": label,
                        "confidence": score
                    })
                    
                    # Store centroid for Anatomical Distance Analysis
                    centroids.append((x + w/2, y + h/2))
            except Exception:
                continue
        
        # SENTINEL UPGRADE: Anatomical Distance Analysis (Position Mapping)
        # If any two detected "suspicious" centroids are within 120 pixels,
        # it strongly indicates a "Position" or "Interaction", triggering a Safety Override.
        if len(centroids) >= 2:
            import math
            for i in range(len(centroids)):
                for j in range(i + 1, len(centroids)):
                    c1, c2 = centroids[i], centroids[j]
                    dist = math.sqrt((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2)
                    if dist < 120: # Professional threshold for interaction proximity
                        is_unsafe = True
                        max_score = max(max_score, 0.95) # Force high-confidence lock
                        # print(f"[SENTINEL] Interaction detected (dist={dist:.1f}px). Safety Override engaged.")
                        break

        # Override Unified Safety Flag (Hyper-sensitive for 'picture-in-picture' phone screens)
        if nsfw_score > 0.35 or len(regions) > 0:
            is_unsafe = True

        # FAILSAFE: If NSFW detected but no specific regions found, create a full-frame region
        # This ensures the frontend ALWAYS gets coordinates to blur instead of relying on 
        # a generic global blur that may not visually cover the phone screen
        if is_unsafe and len(regions) == 0:
            img_h, img_w = frame.shape[:2]
            regions.append({
                "x": 0, "y": 0, "width": img_w, "height": img_h,
                "label": "GLOBAL_NSFW", "confidence": max(nsfw_score, max_score)
            })
            print(f"[SENTINEL] No regions but NSFW={nsfw_score:.3f}, injecting full-frame region")

        print(f"NSFW Score: {nsfw_score:.4f}")
        print(f"Regions detected: {len(regions)}")

        if len(regions) > 0:
            print(f"[SENTINEL] Unsafe: {is_unsafe}, MaxScore: {max_score:.2f}, Regions: {len(regions)}")

        return {
            "unsafe": is_unsafe,
            "regions": regions,
            "nsfw_score": nsfw_score,
            "max_score": max_score 
        }
