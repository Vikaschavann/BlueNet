from detoxify import Detoxify
import logging

class AbuseModel:
    def __init__(self, model_type="original"):
        self.model_type = model_type
        self.model = None
        logging.info("Initializing Detoxify model...")

    def load(self):
        self.model = Detoxify(self.model_type)
        logging.info("Detoxify model loaded.")

    def analyze(self, text):
        """
        Analyze text for toxicity.
        Returns a dictionary of scores.
        """
        if not text:
            return {}
        if self.model is None:
            self.load()
        return self.model.predict(text)
