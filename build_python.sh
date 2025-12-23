#!/bin/bash
# Build the Python backend executable
mkdir -p desktop-ui/resources
pyinstaller --clean --noconfirm --onefile \
    --name gds-engine \
    --distpath desktop-ui/resources \
    --workpath build/pyinstaller \
    --hidden-import gdstk \
    --hidden-import klayout.db \
    --hidden-import klayout.lay \
    scripts/engine_entry.py
