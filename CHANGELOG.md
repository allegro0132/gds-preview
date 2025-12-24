# Change Log

All notable changes to the "gds-preview" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.4] - 2025-12-24

### Added
- **Desktop Application**:
  - Released a standalone desktop version of GDS Preview (`desktop-ui`).
  - Supports Windows (x64, ARM64, x86), Linux (x64, ARM64), and macOS (Apple Silicon, Intel).
  - Bundles the high-performance Rust backend for all platforms.
- **Cross-Platform Support**:
  - Implemented a full CI/CD pipeline to cross-compile the Rust backend for 6 targets.
  - VS Code extension now automatically downloads and uses the correct binary for the user's OS and architecture.

### Fixed
- **macOS Permissions**:
  - Fixed `EACCES` permission errors by automatically setting executable permissions for the Rust binary on macOS and Linux.

## [0.3.3] - 2025-12-23

### Added
- **Port Visualization**:
  - Added support for visualizing ports in all rendering modes (Canvas, WebGL, SVG).
  - Ports are extracted from `kfactory:ports` metadata or fallback to labels on specific layers.
  - Ports are rendered with arrows indicating orientation and text labels.
  - Added UI controls for ports:
    - Visibility toggle ("Ports" checkbox).
    - Color picker (with "Reset" to layer color).
    - Brightness slider.
  - Added configuration settings:
    - `gdsPreview.portFontSize`: Font size for port labels.
    - `gdsPreview.portArrowScale`: Scale factor for port arrows.
- **UI Improvements**:
  - Added "Select All Layers" functionality by double-clicking the "Layer Control" header.
  - Added "Port Arrow Scale" and "Port Font Size" inputs to the configuration panel.

## [0.3.0] - 2025-12-21

### Added
- **Connected Object Highlighting**:
  - Double-click on any object to highlight it and all physically connected objects (net tracing).
  - Works across all rendering engines (WebGL, Canvas, SVG).
  - **Instance Support**: Fully supports tracing connectivity into and across GDSII instances (references) without flattening.
  - **Dynamic Expansion**: Implemented "Dynamic Instance Expansion" algorithm to efficiently trace connectivity in hierarchical designs.
  - Double-click background to clear highlights.
- **Layer Soloing**:
  - Double-click a layer in the sidebar to isolate it (hide all other layers).

### Fixed
- **Rendering & Coordinates**:
  - Fixed label drift when zooming in SVG mode.
  - Fixed coordinate offsets caused by CSS layout timing.
- **Stability**:
  - Fixed "Maximum call stack size exceeded" error when highlighting large nets.
  - Fixed `pendingTasks` tracking in WebGL mode to ensure correct completion status.
  - Fixed data duplication issues when reloading or resetting the view in WebGL mode.
  - Fixed matrix indexing issues (Column-Major vs Row-Major) for instance hit testing.

## [0.2.5] - 2025-12-20

### Added
- **Instanced Rendering (WebGL)**:
  - Implemented hardware-accelerated instancing using `ANGLE_instanced_arrays`.
  - Significantly reduces memory usage and load times for hierarchical designs with repetitive cells (e.g., memory arrays, standard cell rows).
  - Added `gdsPreview.useInstancing` setting and UI toggle.
- **Negative View for Instanced Mode**:
  - Implemented Stencil Buffer-based negative rendering for instanced geometry.
  - Correctly handles both flat and instanced geometry as "holes" in the layer sheet.

### Fixed
- **Rendering Correctness**:
  - Fixed matrix coordinate system mismatch (Row-Major vs Column-Major) causing sub-cells to render at the origin.
  - Fixed SVG Negative View orientation issue where the view would flip upside down.
  - Fixed rotation direction inconsistency between WebGL (CCW) and SVG (CW) modes.

## [0.2.4] - 2025-12-20

### Added
- **Instanced Rendering**: Implemented `ANGLE_instanced_arrays` support for WebGL to significantly improve performance on hierarchical GDSII files.
  - Added `gdsPreview.useInstancing` configuration option (default: true).
  - Added UI toggle for Instanced Rendering in the configuration panel.

## [0.2.3] - 2025-12-20

### Added
- **Flow Control**: Implemented a flow control mechanism for data streaming to prevent overwhelming the Webview.
  - Added `gdsPreview.flowControlStep` setting to configure the number of chunks sent before waiting for acknowledgement.
  - Added UI control for flow control step in the configuration panel.
## [0.2.1] - 2025-12-19

### Added
- **Negative View**: Implemented negative view mode for inspecting mask polarities.

## [0.2.0] - 2025-12-19

### Added
- **Text Color Controller**: Added ability to customize text label colors independently.
- **Layer Management**: Implemented drag-and-drop support for reordering layers in the layer list.

## [0.1.5] - 2025-12-19

### Changed
- **Layer Rendering**: Changed layer rendering order to reverse lexicographical sorting for better visibility of smaller features.

## [0.1.4] - 2025-12-19

### Added
- **Binary Data Transfer**: Implemented a custom binary protocol (Base64 encoded buffers) for transferring geometry data from Python to the extension.
  - Reduces memory overhead by avoiding JSON serialization for large geometry arrays.
  - Web Workers now parse binary data directly.

### Changed
- **WebGL Optimization**: Optimize performance and robustness.
- **Canvas Optimization**: Updated Canvas rendering to use flat `Float32Array` structures for polygons, reducing memory usage and garbage collection overhead.
- **Status Logging**: Improved status messages to clearly distinguish between geometry chunks and label chunks.

### Fixed
- **Canvas Rendering**: Fixed an issue where Canvas mode would load data but fail to render due to incorrect worker return types.

## [0.1.1] - 2025-12-18

### Added
- **Parallel Loading**: Implemented multi-threaded processing using Web Workers for parsing and triangulating geometry. This significantly improves UI responsiveness during loading.
- **Configuration**:
  - Added `gdsPreview.maxWorkers` setting to control the number of parallel workers.
  - Added `gdsPreview.chunkSize` setting to tune data streaming performance.
  - Added UI controls for these settings in the configuration panel.
- **Performance Metrics**: Added a timer to display the total loading time upon completion.

### Changed
- Optimized data transfer between Python and Webview by streaming raw strings directly to workers.

## [0.1.0] - 2025-12-18

### Added
- **Floating Toolbar**: Added a draggable toolbar for quick access to view controls.
  - Center View.
  - Flip Horizontal / Vertical.
  - Rotate Clockwise / Counter-Clockwise (with custom angle input).
- **UI Improvements**:
  - Moved "Reset" and "Stop" buttons to the VS Code editor title bar.
  - Improved Cell Tree View to hide empty cells and metadata.
  - Added collapsible sidebar for controls.

### Fixed
- **SVG Engine**:
  - Fixed inverted panning direction (Y-axis).
  - Fixed text label alignment and rendering in SVG mode.
  - Fixed color updates for SVG elements.
- **General**:
  - Fixed weird object rendering bugs.
  - Removed obsolete `minLabelZoom` setting.

## [0.0.6] - 2025-12-18

### Added
- Added configuration panel for quick settings adjustment.

### Fixed
- Fixed text rendering issue when changing cells.

## [0.0.5] - 2025-12-18

### Added
- Added `gdsPreview.minLabelZoom` setting to control text visibility threshold.

### Fixed
- Fixed bugs in SVG mode.

## [0.0.4] - 2025-12-18

### Added
- Text rendering support.

## [0.0.2] - 2025-12-18

### Added
- GPU rendering engine (WebGL).
- Multi-layer rendering support.
- Multi-cell selection support.
- Icon and License.

### Changed
- Improved large file render performance.
- Improved UI.

### Fixed
- Fixed text render bug.
- Fixed WebGL to SVG switching bug.
- Fixed fit/center functions.

## [0.0.1] - 2025-12-17

- Initial release