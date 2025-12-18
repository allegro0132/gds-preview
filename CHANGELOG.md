# Change Log

All notable changes to the "gds-preview" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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