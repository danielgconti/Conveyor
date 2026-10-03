"""Image-processing example workload using Pillow.

Contract: read /job/input.json (+ files in /job/input/), write /job/output.json
and the processed image to /job/output/.

Input:
  {
    "imagePath": "/job/input/image.jpg",   # optional: defaults to the first file in /job/input/
    "operation": "resize",                 # resize | thumbnail | grayscale | blur | rotate
    "width": 500, "height": 500,           # resize / thumbnail
    "radius": 4,                           # blur
    "degrees": 90                          # rotate
  }
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

JOB = Path("/job")
OUTPUT_DIR = JOB / "output"


def apply(img: Image.Image, params: dict) -> Image.Image:
    op = params.get("operation", "resize")
    if op == "resize":
        return img.resize((int(params.get("width", 500)), int(params.get("height", 500))))
    if op == "thumbnail":
        img = img.copy()
        img.thumbnail((int(params.get("width", 256)), int(params.get("height", 256))))
        return img
    if op == "grayscale":
        return ImageOps.grayscale(img)
    if op == "blur":
        return img.filter(ImageFilter.GaussianBlur(float(params.get("radius", 4))))
    if op == "rotate":
        return img.rotate(float(params.get("degrees", 90)), expand=True)
    raise ValueError(f"unknown operation {op!r}")


def main() -> int:
    params = json.loads((JOB / "input.json").read_text())

    if "imagePath" in params:
        source = Path(params["imagePath"]).resolve()
        if JOB / "input" not in source.parents:
            print("imagePath must be inside /job/input/", file=sys.stderr)
            return 2
    else:
        files = sorted((JOB / "input").iterdir())
        if not files:
            print("no input image: attach a file or set imagePath", file=sys.stderr)
            return 2
        source = files[0]

    with Image.open(source) as img:
        print(f"loaded {source.name}: {img.width}x{img.height} {img.mode}")
        result = apply(img, params)
        if result.mode not in ("RGB", "RGBA", "L"):
            result = result.convert("RGB")
        out_name = "result.png"
        result.save(OUTPUT_DIR / out_name)
        print(f"wrote {out_name}: {result.width}x{result.height}")

        (JOB / "output.json").write_text(
            json.dumps(
                {
                    "operation": params.get("operation", "resize"),
                    "outputFile": out_name,
                    "original": {"width": img.width, "height": img.height},
                    "result": {"width": result.width, "height": result.height},
                }
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
