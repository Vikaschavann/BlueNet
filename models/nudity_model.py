from nudenet import NudeDetector
import logging

class NudityModel:
    def __init__(self):
        self.detector = None
        logging.info("Initializing NudeNet Detector...")
        
    def load(self):
        # Initialize the detector. It will download the model on first run.
        self.detector = NudeDetector()
        logging.info("NudeNet Detector loaded.")

    def detect(self, frame_path_or_array):
        """
        Detect nudity in a frame.
        returns: list of detected regions
        """
        if self.detector is None:
            self.load()
        return self.detector.detect(frame_path_or_array)
