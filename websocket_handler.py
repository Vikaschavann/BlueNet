import json
import logging
import asyncio
from fastapi import WebSocket, WebSocketDisconnect
from concurrent.futures import ThreadPoolExecutor
from video_moderator import VideoModerator
from audio_moderator import AudioModerator

class WebSocketHandler:
    def __init__(self, video_mod: VideoModerator, audio_mod: AudioModerator):
        self.video_mod = video_mod
        self.audio_mod = audio_mod
        # Optimization: Use a dedicated thread pool for AI inference to utilize 8 cores
        self.executor = ThreadPoolExecutor(max_workers=8)

    async def handle(self, websocket: WebSocket):
        await websocket.accept()
        logging.info(f"WebSocket connection accepted: {websocket.client}")
        loop = asyncio.get_event_loop()
        
        is_processing_video = False
        
        try:
            while True:
                data = await websocket.receive_json()
                
                msg_type = data.get("type")
                payload = data.get("data")
                
                if not payload:
                    await websocket.send_json({"error": "Missing data payload"})
                    continue
                
                if msg_type == "video_frame":
                    if is_processing_video:
                        # DROP FRAME explicitly to avoid latency buildup
                        continue
                        
                    is_processing_video = True
                    try:
                        # Optimization: Offload to ThreadPoolExecutor for real parallel processing
                        result = await loop.run_in_executor(self.executor, self.video_mod.moderate_frame, payload)
                        
                        # STEP 4: Send regions via websocket with type: moderation_result
                        response = {
                            "type": "moderation_result",
                            "regions": result["regions"],
                            "unsafe": result["unsafe"],
                            "max_score": result.get("max_score", 0)
                        }
                        
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
        except Exception as e:
            logging.error(f"Error in WebSocket handler: {e}")
            await websocket.send_json({"error": str(e)})
