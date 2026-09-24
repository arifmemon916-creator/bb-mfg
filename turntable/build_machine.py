"""Turn a machine's reference photos into face textures + a 3D model description.

    python3 build_machine.py machines/<id>          # one machine
    python3 build_machine.py                        # every machines/*/config.json

config.json holds pixel measurements taken from the reference images; this
script converts them to millimetres (model.json) and cuts / perspective-
rectifies each face into machines/<id>/tex/*.png. index.html?machine=<id>
then builds the 3D machine from model.json.
"""
import json
import sys
from pathlib import Path
from PIL import Image

HERE = Path(__file__).parent


def load(mdir, src, cache={}):
    p = (mdir / src).resolve()
    if p not in cache:
        cache[p] = Image.open(p).convert("RGB")
    return cache[p]


def save(img, path, up):
    if up != 1:
        img = img.resize((round(img.width * up), round(img.height * up)), Image.LANCZOS)
    img.save(path, optimize=True)


def rectify(img, quad, w, h):
    """quad = [TL, TR, BR, BL] in source px -> straight w x h image."""
    tl, tr, br, bl = quad
    return img.transform((w, h), Image.QUAD, (*tl, *bl, *br, *tr), Image.BICUBIC)


def build(mdir: Path):
    cfg = json.loads((mdir / "config.json").read_text())
    tex = mdir / "tex"
    tex.mkdir(exist_ok=True)
    up = cfg.get("upscale", 1)
    f = cfg["front"]
    front = load(mdir, f["src"]).copy()
    for p in f.get("patches", []):  # [sx0, sy0, sx1, sy1, dx, dy]: copy clean pixels over a blemish
        front.paste(front.crop(tuple(p[:4])), tuple(p[4:]))

    hx0, hy0, hx1, hy1 = f["header"]
    floor = f["floor"]
    H = cfg["height_mm"]
    sy = H / (floor - hy0)
    sx = cfg["width_mm"] / (hx1 - hx0) if "width_mm" in cfg else sy
    cx = (hx0 + hx1) / 2
    X = lambda px: round((px - cx) * sx, 1)
    Y = lambda py: round((floor - py) * sy, 1)

    px0, py0, px1, py1 = f["panel"]
    tx0, ty0, tx1, ty1 = f["tray"]
    D = cfg["depth_mm"]
    model = {
        "title": cfg["title"],
        "body": {"w": round((px1 - px0) * sx), "h": H, "d": D},
        "head": {"w": round((hx1 - hx0) * sx), "y0": Y(hy1), "depth": cfg.get("header_depth_mm", 48)},
        "panel": {"y0": Y(py1), "y1": Y(py0)},
        "tray": {"w": round((tx1 - tx0) * sx), "h": Y(ty0), "depth": cfg.get("tray_depth_mm", 180)},
        "valves": [],
        "taps": [],
        "rear": None,
    }
    for name, box in (("front_header", f["header"]), ("front_panel", f["panel"]), ("tray_front", f["tray"])):
        save(front.crop(tuple(box)), tex / f"{name}.png", up)

    for i, v in enumerate(f.get("valves", [])):
        rect, extra = (v, {}) if isinstance(v, list) else (v["rect"], v)
        x0, y0, x1, y1 = rect
        save(front.crop(tuple(rect)), tex / f"valve_{i}.png", up)
        model["valves"].append({
            "x": X((x0 + x1) / 2), "w": round((x1 - x0) * sx, 1), "y0": Y(y1), "y1": Y(y0),
            "depth": extra.get("depth_mm", 64), "nozzle": extra.get("nozzle", True), "tex": f"valve_{i}",
        })
    for t in f.get("taps", []):
        model["taps"].append({"x": X(t["x"]), "top": Y(t["top"]), "bottom": Y(t["bottom"])})

    W = model["body"]["w"]
    faces = {"side_right": (D, H), "side_left": (D, H), "rear": (W, H)}
    for name, (wmm, hmm) in faces.items():
        spec = cfg.get(name)
        if not spec:
            continue
        img = load(mdir, spec["src"]).copy()
        for p in spec.get("patches", []):
            img.paste(img.crop(tuple(p[:4])), tuple(p[4:]))
        k = spec.get("px_per_mm", 1.0)
        rectify(img, spec["quad"], round(wmm * k), round(hmm * k)).save(tex / f"{name}.png", optimize=True)
        if name == "rear":
            model["rear"] = "rear"

    (mdir / "model.json").write_text(json.dumps(model, indent=1))
    print(mdir.name, "body", model["body"], "head", model["head"]["w"], "tray", model["tray"]["w"], "valves", len(model["valves"]))


if __name__ == "__main__":
    dirs = [Path(a) for a in sys.argv[1:]] or sorted(p.parent for p in (HERE / "machines").glob("*/config.json"))
    for d in dirs:
        build(d)
