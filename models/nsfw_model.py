import logging
from transformers import pipeline

class NSFWModel:
    def __init__(self):
        self.classifier = None
        logging.info("Initializing Falconsai NSFW Classifier...")

    def load(self):
        if self.classifier is None:
            self.classifier = pipeline("image-classification", model="Falconsai/nsfw_image_detection")
            logging.info("NSFW Classifier loaded.")

    def predict(self, pil_image):
        """
        Predict if an image is NSFW.
        returns: (nsfw_score: float)
        """
        if self.classifier is None:
            self.load()
            
        results = self.classifier(pil_image)
        # Results are usually a list like: [{'label': 'nsfw', 'score': 0.99}, {'label': 'normal', 'score': 0.01}]
        
        nsfw_score = 0.0
        for r in results:
            if r['label'].lower() == 'nsfw':
                nsfw_score = r['score']
                break
                
        return nsfw_score
