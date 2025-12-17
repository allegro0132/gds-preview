# GDSII Preview for VS Code

A high-performance GDSII/OASIS file viewer for Visual Studio Code, featuring GPU-accelerated rendering for handling large integrated circuit layouts.

## Features

- **High-Performance Rendering**: View large GDSII layouts smoothly directly within VS Code.
- **Multi-Engine Support**: Choose between WebGL (GPU), Canvas (CPU), or SVG rendering.
- **Layer Management**: Toggle layer visibility and customize layer colors.
- **Cell Navigation**: Inspect different cells within the GDS library.
- **Interactive Controls**: Pan, zoom, and fit-to-screen capabilities.
- **Performance Optimizations**:
  - **Viewport Culling**: Only renders what is visible on screen.
  - **Dynamic Level of Detail (LOD)**: Automatically reduces detail during fast interactions to maintain high frame rates.

## Rendering Engines

This extension provides three rendering pipelines to suit different needs:

### 1. WebGL (Default & Recommended)
- **Technology**: GPU-accelerated rendering using WebGL.
- **Pros**: Extremely smooth Pan/Zoom performance ("Silky Smooth"). Handles millions of polygons with ease.
- **Cons**: Slightly longer initial load time due to polygon triangulation.
- **Best For**: Large, complex layouts (10MB+).

### 2. SVG
- **Technology**: Scalable Vector Graphics (DOM-based).
- **Pros**: Perfect vector fidelity at any zoom level. Easy to inspect via DOM tools.
- **Cons**: Very high memory usage and slow rendering for large files.
- **Best For**:  Medium-sized layouts, high-quality static screenshots or where WebGL might be overkill or incompatible.

### 3. Canvas
- **Technology**: HTML5 Canvas 2D Context (CPU-based).
- **Pros**: Fast initial load. Good compatibility.
- **Cons**: Performance drops significantly with high polygon counts.
- **Best For**: Small cells, debugging.

## Extension Settings

This extension contributes the following settings:

* `gdsPreview.renderingEngine`: Select the rendering backend.
  * `webgl` (Default): GPU acceleration.
  * `canvas`: Standard HTML5 Canvas.
  * `svg`: Legacy vector rendering.

* `gdsPreview.fastModeThreshold`: (Default: `10`)
  * Controls the aggressiveness of the Dynamic LOD optimization.
  * Specifies the minimum pixel size for polygons to be rendered during interaction (panning/zooming).
  * Higher values (e.g., 20, 50) improve interaction fluidity but temporarily reduce detail.

* `gdsPreview.pythonPath`: (Default: `python`)
  * Path to the Python executable used for parsing GDSII files.
  * Useful if you have multiple Python installations or use a virtual environment.

## Requirements

- **Python 3**: Required for parsing GDSII files.
- **gdstk**: Python library for GDSII manipulation.
  - The extension will attempt to automatically install `gdstk` if it is missing (`pip install gdstk`).
  - You can also install it manually using `pip install gdstk`.

## Known Issues

- WebGL mode requires a graphics-capable environment.
- Very large files may take a moment to parse before the first render appears.

## Release Notes

### 0.0.1
- Initial release with SVG, Canvas, and WebGL support.
- Implemented Viewport Culling and Dynamic LOD.
