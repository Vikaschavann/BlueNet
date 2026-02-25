import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket
from models.nudity_model import NudityModel
from models.speech_model import SpeechModel
from models.abuse_model import AbuseModel
from video_moderator import VideoModerator
from audio_moderator import AudioModerator
from websocket_handler import WebSocketHandler

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Global model instances
nudity_model = NudityModel()
speech_model = SpeechModel()
abuse_model = AbuseModel()

# Global moderators
video_moderator = VideoModerator(nudity_model)
audio_moderator = AudioModerator(speech_model, abuse_model)
ws_handler = WebSocketHandler(video_moderator, audio_moderator)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load models into memory on startup
    logging.info("Starting up: Loading AI models...")
    nudity_model.load()
    speech_model.load()
    abuse_model.load()
    yield
    # Clean up on shutdown if needed
    logging.info("Shutting down...")

app = FastAPI(
    title="Real-Time AI Moderation Engine",
    description="Backend for real-time video call moderation",
    lifespan=lifespan
)

@app.get("/")
async def root():
    return {"status": "online", "message": "Moderation Engine is running"}

@app.websocket("/ws/moderate")
async def websocket_endpoint(websocket: WebSocket):
    await ws_handler.handle(websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
