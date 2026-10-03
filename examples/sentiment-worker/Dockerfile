FROM python:3.12-slim
WORKDIR /app

# CPU-only PyTorch keeps the image far smaller than the default CUDA build.
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir transformers==4.56.1

# Bake the pretrained model into the image: job containers run with no network.
ENV HF_HOME=/opt/hf \
    MODEL_NAME=distilbert-base-uncased-finetuned-sst-2-english
RUN python -c "from transformers import pipeline; pipeline('sentiment-analysis', model='${MODEL_NAME}')" \
 && chmod -R a+rX /opt/hf
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HOME=/tmp

COPY main.py .
USER 65534:65534
CMD ["python", "-u", "main.py"]
