"""Cut the reference photos into the face textures used by the 3D model.

All front-view coordinates are in pixels of reference/front.png, where
1 px ~= 1 mm on the real machine (body width 920 px = 920 mm).
"""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).parent
REF = HERE / "reference"
OUT = HERE / "textures"
OUT.mkdir(exist_ok=True)

front = Image.open(REF / "front.png").convert("RGB")
side_r = Image.open(REF / "side-right.png").convert("RGB")  # front of machine on the image's left
side_l = Image.open(REF / "side-left.png").convert("RGB")   # front of machine on the image's right

# Remove the image-generator sparkle watermark from the side panel by patching
# it with the plain brushed steel directly above (same column, so edges line up).
side_r.paste(side_r.crop((872, 810, 930, 868)), (872, 872))

crops = {
    "front_header": (front, (50, 100, 970, 320)),
    "front_panel": (front, (58, 320, 964, 800)),
    "tray_front": (front, (18, 825, 1004, 918)),
    "side_right": (side_r, (273, 69, 921, 947)),
    "side_left": (side_l, (178, 66, 754, 944)),
}
VALVE_X = [146, 218, 289, 361, 433, 517, 589, 660, 732, 806]
for i, x in enumerate(VALVE_X):
    crops[f"valve_{i}"] = (front, (x, 379, x + 60, 487))

for name, (img, box) in crops.items():
    img.crop(box).save(OUT / f"{name}.png", optimize=True)
    print(name, box)
