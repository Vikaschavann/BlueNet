from faster_whisper import WhisperModel
import logging
import os

class SpeechModel:
    def __init__(self, model_size="tiny", device="cpu", compute_type="int8"):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.model = None
        logging.info(f"Initializing Whisper model ({model_size})...")

    def load(self):
        # Using tiny model and int8 for low latency on CPU by default
        self.model = WhisperModel(self.model_size, device=self.device, compute_type=self.compute_type)
        logging.info("Whisper model loaded.")

    def transcribe(self, audio_data):
        """
        Transcribe audio chunk.
        audio_data: np.ndarray or path
        """
        if self.model is None:
            self.load()
        
        segments, info = self.model.transcribe(audio_data, beam_size=5)
        text = "".join([segment.text for segment in segments])
        return text.strip()
