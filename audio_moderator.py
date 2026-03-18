import base64
import numpy as np
import io
import wave
from models.speech_model import SpeechModel
from models.abuse_model import AbuseModel

class AudioModerator:
    def __init__(self, speech_model: SpeechModel, abuse_model: AbuseModel):
        self.speech_model = speech_model
        self.abuse_model = abuse_model
        self.toxicity_threshold = 0.7

    def decode_audio(self, base64_data):
        """Decodes base64 audio data to a format Whisper can process."""
        if isinstance(base64_data, str):
            if "," in base64_data:
                base64_data = base64_data.split(",")[1]
            base64_data = base64_data.encode("utf-8")
        
        audio_bytes = base64.b64decode(base64_data)
        
        if len(audio_bytes) < 100:
            print("[AUDIO] Skip: Buffer too small")
            return None
            
        import tempfile
        # Whisper-faster expects a float32 array or a file path.
        # Tempfile allows robust FFmpeg parsing underneath (which faster-whisper uses).
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as temp_audio:
                temp_audio.write(audio_bytes)
                return temp_audio.name
        except Exception as e:
            print(f"[AUDIO] Temp file creation failed: {e}")
            return None

    def moderate_audio(self, base64_audio):
        """
        Transcribes audio and checks for abusive language.
        """
        import os
        audio_file_path = self.decode_audio(base64_audio)
        if audio_file_path is None:
            return {"abusive": False, "action": "allow", "text": ""}
        
        # 1. Transcribe with resilience for malformed headers
        text = ""
        try:
            text = self.speech_model.transcribe(audio_file_path)
        except Exception as e:
            pass # Skip partial chunk
        finally:
            if os.path.exists(audio_file_path):
                try:
                    os.remove(audio_file_path)
                except Exception:
                    pass

        if not text:
            return {"abusive": False, "action": "allow", "text": ""}

        # 2. Analyze toxicity
        scores = self.abuse_model.analyze(text)
        
        # Detoxify returns a dict: {'toxicity': 0.1, 'severe_toxicity': 0.05, ...}
        # We sum or check if any score exceeds threshold
        is_abusive = False
        for category, score in scores.items():
            if isinstance(score, list): score = score[0] # Handle batch output if any
            if score > self.toxicity_threshold:
                is_abusive = True
                break
        
        return {
            "abusive": is_abusive,
            "action": "mute" if is_abusive else "allow",
            "text": text,
            "scores": {k: float(v[0] if isinstance(v, list) else v) for k, v in scores.items()}
        }
