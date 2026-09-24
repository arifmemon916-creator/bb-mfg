#!/bin/sh
# Render every new machine at 4K, then make a 1080p copy.
cd "$(dirname "$0")/.."
export FFMPEG=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")
for m in "$@"; do
  node render.mjs --machine $m --w 3840 --h 2160 > out/render-$m.log 2>&1 || { echo "FAILED $m"; continue; }
  $FFMPEG -y -loglevel error -i out/$m-turntable-4k.mp4 -vf scale=1920:1080:flags=lanczos -c:v libx264 -preset slow -crf 17 \
    -pix_fmt yuv420p -movflags +faststart out/$m-turntable-1080p.mp4 && echo "DONE $m"
done
echo ALL_FINISHED
