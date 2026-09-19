#!/bin/sh
# Copia el relay al teléfono Android por USB (adb). En Termux, después:
#   cp -r /sdcard/Download/walkie-wake ~/ && python ~/walkie-wake/wake.py
set -e
cd "$(dirname "$0")"
out=$(mktemp -d)/walkie-wake
mkdir -p "$out/web"
cp wake.py "$out/"
cp web/* "$out/web/"
cp ../../public/style.css "$out/web/"
adb push "$out" /sdcard/Download/
