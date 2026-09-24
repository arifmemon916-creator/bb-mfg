# PIO BINDAS / BB Manufacturing: 360° product turntables

Real 3D reconstructions of PIO BINDAS soda machines, each rendered as a 12-second,
16:9, 4K 360° turntable video. Every machine is one solid 3D object built from its
reference views. The videos are **not** made by morphing or crossfading between
photographs.

| Machine (`machines/<id>`) | Size used (W × H × D) | Video |
|---|---|---|
| `pio-10-valve`: 10 valves + 2 soda taps | 906 × 818 × 604 mm | `out/pio-10-valve-turntable-{4k,1080p}.mp4` |
| `pio-14-valve`: 12 + 2 flavours | 42 × 34 × 28 inch (1067 × 864 × 711 mm) | `out/pio-14-valve-turntable-{4k,1080p}.mp4` |
| `pio-6-valve`: 6 valves + 2 soda taps | 787 × 818 × 578 mm | `out/pio-6-valve-turntable-{4k,1080p}.mp4` |
| `pio-5-valve`: 5 valves (+ 1 narrow) + 2 soda taps | 745 × 818 × 558 mm | `out/pio-5-valve-turntable-{4k,1080p}.mp4` |
| `pio-single-tap`: 1 tap with digital display | 635 × 818 × 558 mm | `out/pio-single-tap-turntable-{4k,1080p}.mp4` |

All videos are 3840×2160 (plus a 1920×1080 copy), 30 fps, 12 s. Each is one full
clockwise turn (front → right → rear → left → front) that loops seamlessly.
Only the 14-valve machine came with real dimensions. The others use a standard
818 mm height, and their width and depth are taken from their photos in proportion.

## Files

| File | What it is |
|---|---|
| `machines/<id>/config.json` | Pixel measurements taken from that machine's reference images: header, tap panel, drip tray, each valve, the taps, and the four corners of each side/rear face. |
| `build_machine.py` | Turns a config into `model.json` (millimetres) and face textures in `tex/`. Side and rear faces seen at an angle are perspective-corrected. |
| `index.html` | Three.js scene. `index.html?machine=<id>` builds that machine. Open it through a static server (`npx serve .`) to watch it live. Click to pause. |
| `render.mjs` | Headless-Chromium renderer that draws each frame and streams it to ffmpeg. |
| `vendor/` | three.js r186. |

## How each model is built

* **Photo-accurate faces:** the branded header, the tap/advert panel, the drip-tray
  front, both side panels and (when supplied) the rear use the reference photos
  directly, so logos, phone numbers, grilles and handles are not redrawn.
* **Real 3D hardware:** valve housings (each with its own photographed label),
  nozzles, push levers, chrome taps with black handles, the digital display box,
  the drip-tray grate and the rubber feet are modelled geometry.
* **Studio:** a dark navy showroom with softbox reflections, soft shadows, rim
  lights, a subtle reflective floor, and a matte-black 7 cm turntable with index marks
  on a fixed LED base. The platform and camera scale with the machine size.

## Adding another machine

1. Put its reference image(s) in `machines/<new-id>/` and write `config.json`
   (copy one of the existing ones and re-measure the pixel boxes).
2. `python3 build_machine.py machines/<new-id>`
3. Preview: `node render.mjs --machine <new-id> --w 1280 --h 720 --only 0,45,90,180,270`
4. Final: `FFMPEG=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())") node render.mjs --machine <new-id>`

Requirements: `pip install pillow imageio-ffmpeg`, `npm i playwright`.
