# PIO BINDAS / BB Manufacturing: 360° product turntable

A real 3D reconstruction of the 10-valve soda dispenser, rendered as a 12-second,
16:9, 360° turntable animation. The machine is one solid 3D object built from the
supplied front, side, top and bottom reference views. The video is **not** made by
morphing or crossfading between photographs.

| File | What it is |
|---|---|
| `out/pio-bindas-turntable-4k.mp4` | Final video: 3840×2160, 30 fps, 12 s, one full clockwise turn (front → right → rear → left → front). It loops seamlessly. |
| `out/pio-bindas-turntable-1080p.mp4` | The same video at 1920×1080. |
| `index.html` | Three.js scene. Open it through any static server (`npx serve .`) to watch it play live. Click to pause. |
| `render.mjs` | Headless-Chromium renderer that draws each frame and streams it to ffmpeg. |
| `build_textures.py` | Cuts the reference photos into face textures (`textures/`). |
| `reference/` | The supplied reference photos. |

## How the model is built

* **Scale:** 1 px of `reference/front.png` ≈ 1 mm. Body 906 × 818 × 604 mm, branded
  header 920 mm wide and 48 mm proud of the body, drip tray 986 × 93 mm projecting 180 mm.
* **Photo-accurate faces:** the header, tap/advert panel, drip-tray front and both
  side panels use the supplied photos directly. Logos, phone numbers, blue grilles,
  handles and screws are pixel-for-pixel from the reference, not redrawn.
* **Real 3D hardware:** the 10 valve housings (each with its own photographed label),
  nozzles, push levers, the two chrome taps with black handles, the drip-tray grate
  and the rubber feet are all modelled geometry.
* **Rear/top/bottom:** no straight-on rear photo was supplied, so the rear is modelled
  from the top/rear view: brushed T304 steel, a panel seam, a wide blue grille and
  corner screws.
* **Studio:** a dark navy showroom with softbox reflections, a key light with soft
  shadows, twin rim lights, and a subtle reflective floor. The matte-black turntable
  is 7 cm tall with index marks around the edge so the rotation is easy to see. It
  sits on a fixed base ring lit by a thin LED line.

## Re-rendering

```bash
pip install pillow imageio-ffmpeg          # ffmpeg with libx264
npm i three@0.186.0 playwright             # three is vendored in vendor/ already
python3 build_textures.py
FFMPEG=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())") \
  node render.mjs --w 3840 --h 2160 --out out/pio-bindas-turntable-4k.mp4
node render.mjs --only 0,90,180,270 --w 1280 --h 720   # quick preview stills
```
