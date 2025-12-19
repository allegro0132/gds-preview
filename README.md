# GDSII Preview for VS Code

A high-performance GDSII/OASIS file viewer for Visual Studio Code, featuring GPU-accelerated rendering for handling large integrated circuit layouts.

## Features

- **High-Performance Rendering**: View large GDSII layouts smoothly directly within VS Code.
- **Multi-Engine Support**: Choose between WebGL (GPU), Canvas (CPU), or SVG rendering.
- **Text Rendering**: Displays text labels and annotations within the GDSII layout, with customizable colors.
- **Layer Management**: Toggle layer visibility, customize layer colors, and reorder layers via drag-and-drop.
- **Negative View**: Inspect mask polarities with negative view mode.
- **Cell Navigation**: Inspect different cells within the GDS library.
- **Interactive Controls**:
  - **Floating Toolbar**: Draggable toolbar for common view operations.
  - **Transformations**: Flip (Horizontal/Vertical) and Rotate (CW/CCW) the layout.
  - **Pan & Zoom**: Smooth navigation with mouse and scroll wheel.
  - **Fit View**: Quickly center and fit the layout to the screen.
- **Configuration Panel**: Quick access to rendering settings and parameters directly within the viewer.
- **Performance Optimizations**:
  - **Parallel Loading**: Uses Web Workers to parse and process geometry off the main thread.
  - **Binary Streaming**: Uses efficient binary data transfer (Base64 encoded buffers) to minimize overhead between Python and VS Code.
  - **Incremental Rendering**: Streams data for all modes (WebGL, Canvas) to provide immediate visual feedback.
  - **Viewport Culling**: Only renders what is visible on screen.
  - **Dynamic Level of Detail (LOD)**: Automatically reduces detail during fast interactions to maintain high frame rates.
  - **Instanced Rendering**: Uses hardware instancing (`ANGLE_instanced_arrays`) to efficiently render hierarchical designs with thousands of repeated cells.

## Rendering Engines

This extension provides three rendering pipelines to suit different needs:

### 1. WebGL (Default & Recommended)
- **Technology**: GPU-accelerated rendering using WebGL.
- **Pros**: Extremely smooth Pan/Zoom performance ("Silky Smooth"). Handles millions of polygons with ease. Supports **Instanced Rendering** for hierarchical designs.
- **Cons**: Slightly longer initial load time due to polygon triangulation.
- **Best For**: Large, complex layouts (10MB+), hierarchical designs.

### 2. SVG
- **Technology**: Scalable Vector Graphics (DOM-based).
- **Pros**: Perfect vector fidelity at any zoom level. Easy to inspect via DOM tools.
- **Cons**: High memory usage for very large files (though improved with streaming).
- **Best For**: Medium-sized layouts, high-quality static screenshots.

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

* `gdsPreview.useInstancing`: (Default: `true`)
  * Enables hardware instancing for WebGL mode.
  * Greatly improves performance for hierarchical designs (e.g., memory arrays).
  * If disabled, the design is flattened before rendering (legacy behavior).

* `gdsPreview.fastModeThreshold`: (Default: `10`)
  * Controls the aggressiveness of the Dynamic LOD optimization (Only use for Canvas engine).
  * Specifies the minimum pixel size for polygons to be rendered during interaction (panning/zooming).
  * Higher values (e.g., 20, 50) improve interaction fluidity but temporarily reduce detail.

* `gdsPreview.labelFontSize`: (Default: `12`)
  * Font size for text labels in pixels.

* `gdsPreview.maxWorkers`: (Default: `-1`)
  * Number of Web Workers to use for parallel processing.
  * Set to `-1` to automatically use all available CPU cores.

* `gdsPreview.chunkSize`: (Default: `2000`)
  * Number of polygons per data chunk streamed from Python.
  * Adjusting this can help balance memory usage and throughput.

* `gdsPreview.flowControlStep`: (Default: `5`)
  * Number of chunks to send before waiting for a signal from the frontend.
  * Helps prevent the extension host from being overwhelmed by data.
  * Set to `-1` to disable flow control.

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
