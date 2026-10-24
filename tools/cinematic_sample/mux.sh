#!/bin/bash
# Mux rendered PNG frames with the Piper line (delayed to the speech start) into an H.264/AAC MP4.
set -e
D=$(cd "$(dirname "$0")" && pwd)
OUT=$D/che_cinematic_sample.mp4
ffmpeg -y -v error -framerate 24 -i $D/frames/f_%04d.png -i $D/line.wav \
  -filter_complex "[1:a]adelay=6000|6000,loudnorm=I=-16:TP=-1.5:LRA=11,apad[a]" \
  -map 0:v -map "[a]" -t 12 -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 160k -ar 48000 "$OUT"
ffmpeg -y -v error -ss 9 -i "$OUT" -frames:v 1 $D/che_cinematic_thumb_9s.png
echo "$OUT"
