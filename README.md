# GDSII Preview for VS Code

A high-performance GDSII/OASIS file viewer for Visual Studio Code, featuring GPU-accelerated rendering for handling large integrated circuit layouts.

## Features

- **High-Performance Rendering**: View large GDSII layouts smoothly directly within VS Code.
- **GDSII & OASIS Support**: Open both `.gds`/`.gdsii` and `.oas` files, including full OASIS files support (using **CBLOCK** compression with and/or strict mode) with Rust backend.
- **Multi-Engine Support**: Choose between WebGL (GPU), Canvas (CPU), or SVG rendering.
- **Text Rendering**: Displays text labels and annotations within the GDSII layout, with customizable colors.
- **Port Visualization**:
  - Visualizes ports with orientation arrows and labels.
  - Supports `kfactory` metadata and standard layer-based ports.
  - Customizable visibility, color, size, and arrow scale.
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
- **Advanced Analysis**:
  - **Net Tracing**: Double-click any object to highlight all physically connected polygons (Net Tracing). Works across instances and hierarchy.
  - **Layer Soloing**: Double-click a layer in the sidebar to instantly isolate it.

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

* `gdsPreview.portFontSize`: (Default: `12`)
  * Font size for port labels in pixels.

* `gdsPreview.portArrowScale`: (Default: `1.0`)
  * Scale factor for port arrows.

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

* `gdsPreview.maxSteps`: (Default: `5000`)
  * The max steps for connected objects finding algorithm.
  * Adjusting this can help cut off heavy finding problems.

* `gdsPreview.pythonPath`: (Default: `python`)
  * Path to the Python executable used for parsing GDSII files.
  * Required when `engineType` is set to `python`.
  * Useful if you have multiple Python installations or use a virtual environment.

* `gdsPreview.engineType`: (Default: `rust`)
  * Choose which backend engine to use for GDS file processing.
  * `rust` (Default): Experimental Rust-based backend with faster performance.
  * `python`: Original Python-based backend using `gdstk`.
  * The Rust backend provides better performance but is still experimental. Switch to Python if you encounter issues.

## Backend Engines

This extension supports two backend engines for processing GDSII/OASIS files:

### Rust Backend (Default & Recommended)
- **Status**: Experimental, actively developed
- **Performance**: Significantly faster than Python for large files
- **Compatibility**: Cross-platform (Windows, Linux, macOS) with automatic binary downloads
- **Dependencies**: None (standalone binary)
- **Formats**: Supports both **GDSII** and **OASIS** (including **CBLOCK**-compressed OASIS)
- **Best For**: Large files, production use (once stable)

### Python Backend
- **Status**: Stable, original implementation
- **Performance**: Good for most files
- **Dependencies**: Requires Python 3 and `gdstk` library
- **Best For**: Maximum compatibility, debugging, or if Rust backend encounters issues

To switch between backends, change the `gdsPreview.engineType` setting in VS Code:
1. Open VS Code Settings (File → Preferences → Settings)
2. Search for `gdsPreview.engineType`
3. Select either `rust` or `python`
4. Close and reopen the GDS file to apply the new backend

## Desktop Application

A standalone desktop version of GDS Preview is available for Windows, Linux, and macOS.

### macOS Installation Note

The macOS desktop application is not notarized by Apple. If you encounter a "damaged" error when trying to open it:

> "GDSII Preview" is damaged and can’t be opened. You should move it to the Trash.

Please run the following command in your terminal to clear the quarantine attribute:

```bash
xattr -cr "/Applications/GDSII Preview.app"
```

(Replace `/Applications/GDSII Preview.app` with the actual path to the app if you installed it elsewhere).

## Requirements

### For Rust Backend (Default)
- **No external dependencies required**
  - The Rust backend is a standalone binary that will be automatically downloaded for your platform.

### For Python Backend
- **Python 3**: Required when using the Python backend (`gdsPreview.engineType: python`).
- **gdstk**: Python library for GDSII manipulation.
  - The extension will attempt to automatically install `gdstk` if it is missing (`pip install gdstk`).
  - You can also install it manually using `pip install gdstk`.
- **klayout**: Python library (`klayout.db`) required for advanced port extraction (e.g., `kfactory` metadata).
  - The extension will attempt to automatically install missing dependencies.
  - You can also install them manually using `pip install gdstk klayout`.

## Known Issues

- WebGL mode requires a graphics-capable environment.
- Very large files may take a moment to parse before the first render appears.
