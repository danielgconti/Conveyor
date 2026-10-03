FROM python:3.12-alpine
WORKDIR /app
COPY main.py .
# The platform runs jobs as an unprivileged user; nothing here needs root.
USER 65534:65534
CMD ["python", "-u", "main.py"]
