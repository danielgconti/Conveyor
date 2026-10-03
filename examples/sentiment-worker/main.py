"""ML inference example workload: sentiment analysis with a pretrained DistilBERT.

The platform knows nothing about the model; it just runs this container.

Input:   {"text": "I love this"}  or  {"texts": ["great", "awful"]}
Output:  {"model": "...", "results": [{"text": "...", "label": "POSITIVE", "score": 0.999}]}

Needs roughly 1 GB of memory: submit with "memory": "1g".
"""

import json
import os
import sys
from pathlib import Path

from transformers import pipeline


def main() -> int:
    payload = json.loads(Path("/job/input.json").read_text())
    texts = payload.get("texts") or ([payload["text"]] if "text" in payload else [])
    if not texts or not all(isinstance(t, str) for t in texts):
        print("provide 'text' (string) or 'texts' (list of strings)", file=sys.stderr)
        return 2

    model = os.environ["MODEL_NAME"]
    print(f"loading {model}")
    classifier = pipeline("sentiment-analysis", model=model)
    predictions = classifier(texts, truncation=True)

    results = [
        {"text": text, "label": p["label"], "score": round(float(p["score"]), 4)}
        for text, p in zip(texts, predictions)
    ]
    print(f"classified {len(results)} text(s)")
    Path("/job/output.json").write_text(json.dumps({"model": model, "results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
