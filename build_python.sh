#!/bin/bash
# Build the Python backend executable
mkdir -p desktop-ui/resources
pyinstaller --clean --noconfirm \
    --distpath desktop-ui/resources \
    --workpath build/pyinstaller \
    gds-engine.spec
