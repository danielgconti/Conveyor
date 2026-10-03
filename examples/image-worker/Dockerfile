FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir Pillow==11.3.0
COPY main.py .
USER 65534:65534
CMD ["python", "-u", "main.py"]
