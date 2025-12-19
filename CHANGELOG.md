# Change Log

All notable changes to the "gds-preview" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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