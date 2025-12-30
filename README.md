# GDSII Preview

A high-performance GDSII/OASIS file viewer (offer Visual Studio Code extension + Desktop app), featuring multi-thread processing and GPU-accelerated rendering for handling large integrated circuit layouts.

## Features

- **High-Performance Rendering**: View large GDSII layouts smoothly directly within VS Code.
- **GDSII & OASIS Support**: Open both `.gds`/`.gdsii` and `.oas` files, including full OASIS files support (using **CBLOCK** compression and/or strict mode) with Rust backend.
- **Multi-Engine Support**: Choose between WebGL (GPU), Canvas (CPU), or SVG rendering (deprecated, only support legacy Python backend).
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
  - **Measure Tool**:
    - Toggle with the toolbar `M` button or the `M` key.
    - Click to create measurements; each pair of clicks adds a new measurement record.
    - Snaps to nearby polygon vertices/edges (vertex snap has higher priority).
    - Hold `Shift` while placing the 2nd point to constrain to horizontal/vertical.
    - Press `Esc` to clear the current in-progress measurement.
- **Configuration Panel**: Quick access to rendering settings and parameters directly within the viewer.
- **Performance Optimizations**:
  - **Parallel Triangulation**: Uses Rust backend to parse and process geometry off the frontend thread.
  - **Binary Streaming**:
    - **Python engine**: Streams geometry via Base64-encoded binary chunks.
    - **Rust engine**: Streams geometry as raw binary frames over a local WebSocket (served by the extension) to avoid Base64 overhead.
  - **Incremental Rendering**: Streams data for all modes (WebGL, Canvas) to provide immediate visual feedback.
  - **Viewport Culling**: Only renders what is visible on screen.
  - **Viewport Streaming (WebGL + Rust)**: Requests geometry on-demand for the current camera viewport (with a small neighborhood padding) to keep huge layouts responsive and avoid client-side memory blowups.
  - **Viewport Polygon Streaming (Measure Snapping, WebGL + Rust)**: When the Measure tool is enabled, the viewer can request viewport-bounded polygons for snapping even when render viewport streaming is disabled.
  - **Dynamic Level of Detail (LOD)**: Automatically reduces detail during fast interactions to maintain high frame rates.
  - **Instanced Rendering**: Uses hardware instancing (`ANGLE_instanced_arrays`) to efficiently render hierarchical designs with thousands of repeated cells.
  - **Backend Triangulation (Rust/WebGL)**: WebGL triangles can be generated in the Rust backend and streamed directly to the webview.
- **Advanced Analysis**:
  - **Net Tracing**: Double-click any object to highlight all physically connected polygons (Net Tracing). Works across instances and hierarchy.
    - Hold `Shift` while double-clicking to union-merge into the existing highlight set.
  - **Point Pick (Right-Click)**: Right-click to highlight the polygon under the cursor (single polygon only; no connected-object expansion).
    - Hold `Shift` while right-clicking to toggle highlight (remove if already highlighted, else add).
  - **Box Select (Right-Drag)**: Right-click and drag to draw a selection box; polygons fully contained in the box will be highlighted.
    - Hold `Shift` while box-selecting to union-merge into the existing highlight set.
  - **Layer Soloing**: Double-click a layer in the sidebar to instantly isolate it.
  - **Layer Tutti**: Double-click `Layer Control` in the sidebar to show all layers.
  - **Copy to KLayout**: After highlighting polygons, press `Cmd/Ctrl+C` to copy a KLayout paste payload (includes layer info). To paste as shapes, install the macro in [klayout/paste_gds_preview_polygons.py](klayout/paste_gds_preview_polygons.py).

  ### Install the KLayout paste macro

  This enables “paste from clipboard into the layout window” for the polygons copied from this viewer.

  1. Open KLayout.
  2. Open the Macro Development IDE:
    - `Tools` → `Macro Development...`
  3. Load the macro file:
    - In Macro Development, choose `Python` → `Import file`
    - Select [klayout/paste_gds_preview_polygons.py](klayout/paste_gds_preview_polygons.py)
    - Make sure it is enabled.
  4. Add a keyboard shortcut:
    - `klayout` → `Preferences...`
    - `Application` → `Customize Menu`
    - Find the macro entry you just loaded (it may appear under the `Main Menu` section), and add a shortcut.
    - Recommended shortcut: `Ctrl+Shift+V`.

  After that, in the KLayout layout window:
  - Use this viewer: highlight polygons → `Cmd/Ctrl+C`
  - In KLayout: press your shortcut (e.g. `Ctrl+Shift+V`) to paste as shapes (polygons will be placed onto their original layers).

## Rendering Engines

This extension provides three rendering pipelines to suit different needs:

### 1. WebGL (Default & Recommended)
- **Technology**: GPU-accelerated rendering using WebGL.
- **Pros**: Extremely smooth Pan/Zoom performance ("Silky Smooth"). Handles millions of polygons with ease. Supports **Instanced Rendering** for hierarchical designs.
- **Cons**: Partial support for Viewport Culling when using instanced rendering.
- **Best For**: Large, complex layouts (1GB+), hierarchical designs.

### 2. Canvas
- **Technology**: HTML5 Canvas 2D Context (CPU-based).
- **Pros**: Fast initial load. Good compatibility. Full support for Viewport Culling and LOD.
- **Cons**: Performance drops significantly with high polygon counts.
- **Best For**: Small cells (~1MB), debugging.

### 3. SVG (Deprecated, only in legacy Python backend)
- **Technology**: Scalable Vector Graphics (DOM-based).
- **Pros**: Perfect vector fidelity at any zoom level. Easy to inspect via DOM tools.
- **Cons**: High memory usage for very large files (though improved with streaming).
- **Best For**: Medium-sized layouts (~10MB), high-quality static screenshots.

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
  * Controls parallelism.
  * **Python engine**: Number of Web Workers.
  * **Rust engine**: Number of Rayon worker threads for triangulation and search.
  * Set to `-1` to use all available CPU cores.

* `gdsPreview.chunkSize`: (Default: `2000`)
  * Number of polygons per data chunk streamed from Python.
  * Adjusting this can help balance memory usage and throughput.

* `gdsPreview.flowControlStep`: (Default: `5`)
  * Number of chunks to send before waiting for a signal from the frontend.
  * Helps prevent the extension host from being overwhelmed by data.
  * Set to `-1` to disable flow control.
  * Note: This setting applies to legacy stdout/Base64 streaming. In Rust TCP/WebSocket binary streaming mode, stdin is reserved for JSON commands and stdin-based flow control is disabled.

* `gdsPreview.viewportStreaming`: (Default: `false`)
  * **(WebGL + Rust)** Streams geometry on-demand based on the current viewport instead of streaming the entire design.
  * Best for extremely large layouts where full streaming would be too slow or memory-heavy.

* `gdsPreview.viewportPaddingFactor`: (Default: `0.25`)
  * Extra neighborhood margin around the current viewport.
  * Interpreted as a fraction of `max(viewportWidth, viewportHeight)` in world units.
  * Higher values reduce visible pop-in while panning, at the cost of fetching more geometry per request.

* `gdsPreview.viewportDebounceMs`: (Default: `80`)
  * Debounce interval (ms) for viewport geometry requests during pan/zoom.
  * Higher values reduce request frequency (less CPU/network churn) but increase latency.

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

#### Rust Streaming Notes

- In Rust + WebGL mode, geometry may be streamed as binary frames over a local WebSocket.
- When streaming in true incremental mode, the total number of chunks may be unknown up-front (the UI will show per-chunk progress without a total).
- When using TCP/WebSocket streaming, stdin is reserved for JSON commands (e.g. viewport updates, search). Stdin-based flow-control is disabled in this mode.

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
