import json
import logging
import asyncio
import time
import uuid
import numpy as np
import cv2
import base64
from fastapi import WebSocket, WebSocketDisconnect
from concurrent.futures import ThreadPoolExecutor
from video_moderator import VideoModerator
from audio_moderator import AudioModerator

class WebSocketHandler:
    def __init__(self, video_mod: VideoModerator, audio_mod: AudioModerator):
        self.video_mod = video_mod
        self.audio_mod = audio_mod
        # Optimization: Use smaller thread pool to reduce context switching overhead
        self.executor = ThreadPoolExecutor(max_workers=4)
        
        # Admin Dashboard State
        self.connected_users = {}
        self.admin_websockets = []
        
    def _decode_frame(self, base64_frame):
        try:
            if isinstance(base64_frame, str):
                if "data:image" in base64_frame and ";base64," in base64_frame:
                    base64_frame = base64_frame.split(";base64,")[1]
                elif "," in base64_frame:
                    base64_frame = base64_frame.split(",")[1]
            img_bytes = base64.b64decode(base64_frame)
            nparr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE) # Grayscale for bypass detection
            return cv2.resize(frame, (32, 32)) # Downsample aggressively for fast processing
        except Exception:
            return None

    async def broadcast_admin_metrics(self):
        # Format the metrics
        users_list = [
            {
                "id": uid,
                "riskScore": data.get("risk_score", 0),
                "violations": data.get("violations", 0),
                "status": data.get("status", "safe")
            }
            for uid, data in self.connected_users.items()
        ]
        message = {"type": "metrics", "data": {"users": users_list}}
        
        # Broadcast to all admin websockets
        dead_admins = []
        for ws in self.admin_websockets:
            try:
                await ws.send_json(message)
            except Exception:
                dead_admins.append(ws)
        
        for ws in dead_admins:
            self.admin_websockets.remove(ws)

    async def handle_admin(self, websocket: WebSocket):
        await websocket.accept()
        self.admin_websockets.append(websocket)
        logging.info("Admin connected")
        await self.broadcast_admin_metrics()
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            if websocket in self.admin_websockets:
                self.admin_websockets.remove(websocket)

    async def handle(self, websocket: WebSocket):
        await websocket.accept()
        logging.info(f"WebSocket connection accepted: {websocket.client}")
        loop = asyncio.get_event_loop()
        
        is_processing_video = False
        
        session_id = str(uuid.uuid4())
        user_id = session_id
        
        self.connected_users[user_id] = {
            "violations": 0,
            "last_violation": 0,
            "risk_score": 0.0,
            "status": "safe",
            "last_frames": [], # For frozen detection
        }
        await self.broadcast_admin_metrics()
        
        try:
            while True:
                data = await websocket.receive_json()
                
                msg_type = data.get("type")
                payload = data.get("data")
                
                if not payload:
                    await websocket.send_json({"error": "Missing data payload"})
                    continue
                
                if msg_type == "video_frame":
                    # Update User ID if provided
                    client_user_id = payload.get("user_id") if isinstance(payload, dict) else None
                    if client_user_id and client_user_id != user_id:
                        if user_id in self.connected_users:
                            old_data = self.connected_users.pop(user_id)
                            user_id = client_user_id
                            self.connected_users[user_id] = old_data
                            await self.broadcast_admin_metrics()

                    if is_processing_video:
                        # DROP FRAME explicitly to avoid latency buildup
                        continue
                        
                    is_processing_video = True
                    try:
                        source = "webcam"
                        frame_data = payload
                        if isinstance(payload, dict):
                            frame_data = payload.get("frame")
                            source = payload.get("source_type", "webcam")
                            
                        # print(f"Frame received from: {source}")
                        
                        # --- FEATURE 2: ANTI-BYPASS DETECTION ---
                        bypass_detected = False
                        bypass_type = None
                        
                        small_frame = await loop.run_in_executor(None, self._decode_frame, frame_data)
                        if small_frame is not None:
                            avg_brightness = np.mean(small_frame)
                            if avg_brightness < 10: # Black screen threshold
                                bypass_detected = True
                                bypass_type = "black"
                            
                            frames_history = self.connected_users[user_id]["last_frames"]
                            frames_history.append(small_frame)
                            if len(frames_history) > 2:
                                frames_history.pop(0)
                            
                            if len(frames_history) == 2 and not bypass_detected:
                                # Check structural similarity (frozen frame) with just 2 frames
                                diff = cv2.absdiff(frames_history[0], frames_history[1])
                                if np.mean(diff) < 2:
                                    bypass_detected = True
                                    bypass_type = "frozen"
                        
                        # Optimization: Offload to ThreadPoolExecutor for real parallel processing
                        result = await loop.run_in_executor(self.executor, self.video_mod.moderate_frame, frame_data)
                        
                        nsfw_score = result.get("nsfw_score", 0.0)
                        max_score = result.get("max_score", 0.0)
                        regions = result.get("regions", [])
                        
                        # --- FEATURE 1: RISK SCORE ENGINE & FEATURE 5: CONTEXT-AWARE ---
                        user_state = self.connected_users[user_id]
                        
                        # Reset violations if clean for 5 minutes
                        if user_state["violations"] > 0 and time.time() - user_state["last_violation"] > 300:
                            user_state["violations"] = 0
                            
                        violation_history_normalized = min(user_state["violations"] / 5, 1)
                        region_density_score = min(len(regions) / 5, 1)
                        
                        risk_score = (0.5 * nsfw_score) + (0.3 * violation_history_normalized) + (0.2 * region_density_score)
                        
                        if bypass_detected:
                            risk_score = min(1.0, risk_score + 0.3)
                            
                        user_state["risk_score"] = risk_score
                        
                        # --- FEATURE 3: AUTO ENFORCEMENT ---
                        block_thresh = 0.85 if user_state["violations"] < 3 else 0.8
                        blur_thresh = 0.65 if user_state["violations"] < 3 else 0.6
                        warn_thresh = 0.45 if user_state["violations"] < 3 else 0.4
                        
                        action = "safe"
                        if risk_score > block_thresh:
                            action = "block"
                        elif risk_score > blur_thresh or result.get("unsafe"):
                            action = "blur"
                        elif risk_score > warn_thresh:
                            action = "warn"
                            
                        if action in ["blur", "block"]:
                            if time.time() - user_state["last_violation"] > 10:  # throttle violation increments
                                user_state["violations"] += 1
                                user_state["last_violation"] = time.time()
                                
                        v_count = user_state["violations"]
                        if v_count >= 6:
                            action = "remove"
                        elif v_count == 5:
                            action = "block"
                        elif v_count == 4:
                            action = "mute"
                        elif v_count == 3 and action not in ["block", "mute", "remove"]:
                            action = "blur"
                            
                        user_state["status"] = action
                        await self.broadcast_admin_metrics()
                        
                        # STEP 4: Send unified pipeline results via websocket
                        response = {
                            "type": "moderation_result",
                            "regions": regions,
                            "unsafe": action in ["blur", "block", "remove"],
                            "nsfw_score": nsfw_score,
                            "max_score": max_score,
                            "riskScore": risk_score,
                            "violations": v_count,
                            "bypassDetected": bypass_detected,
                            "bypassType": bypass_type,
                            "action": action
                        }
                        
                        # print("Prediction:", response)
                        
                        await websocket.send_json(response)
                    except Exception as e:
                        logging.error(f"Error moderating video frame: {e}")
                        await websocket.send_json({"error": f"Error moderating video frame: {str(e)}"})
                    finally:
                        is_processing_video = False
                    
                elif msg_type == "audio_chunk":
                    try:
                        # Run moderation in a thread pool
                        result = await asyncio.to_thread(self.audio_mod.moderate_audio, payload)
                        await websocket.send_json({
                            "type": "audio_result",
                            "result": result
                        })
                    except Exception as e:
                        logging.error(f"Error moderating audio chunk: {e}")
                        # Don't crash the loop, just log and continue
                    
                else:
                    await websocket.send_json({"error": f"Unknown message type: {msg_type}"})
                    
        except WebSocketDisconnect:
            logging.info(f"WebSocket disconnected: {websocket.client}")
            if user_id in self.connected_users:
                del self.connected_users[user_id]
                await self.broadcast_admin_metrics()
        except Exception as e:
            logging.error(f"Error in WebSocket handler: {e}")
            await websocket.send_json({"error": str(e)})
