export const state = {
    vscode: null,
    config: {},
    perfMetrics: { workerTime: 0, renderTime: 0, mainThreadParseTime: 0 },
    startTime: 0,
    pendingTasks: 0,
    pythonFinished: false,
    completionShown: false,
    completionScheduled: false,
    statusPinUntil: 0,
    geometry: {},
    // Lightweight polygon cache for snapping (especially for WebGL).
    // Format: { [layerKey]: Array< Float32Array | Array<[number, number]> > } where each poly may have poly.bbox
    snapGeometry: {},
    labels: {},
    ports: [],
    bbox: { x_min: 0, x_max: 0, y_min: 0, y_max: 0 },
    activeLayers: new Set(),
    allLayers: [],
    layerColors: {},
    layerOpacities: {},
    showLabels: false,
    labelFontSize: 10,
    portFontSize: 10,
    portArrowScale: 1,
    showPorts: false,
    globalPortColor: null,
    portBrightness: 0.5,
    labelBrightness: 0.5,
    globalLabelColor: null,
    currentEngine: 'canvas',
    fastModeThreshold: 0.5,
    enableProfiling: false,
    flowControlStep: 10,
    useInstancing: true,
    flipState: { x: 1, y: 1 },
    rotationState: 0,
    expandedNodes: new Set(),
    isViewFitted: false,
    hasUserInteracted: false,
    isNegative: false,
    svgFragments: {},
    highlightedPolygons: [],
    highlightedPath: null,
    searchRequestId: null,

    // If true, the next highlight operation (double-click find) will merge (union)
    // with existing highlights instead of replacing them.
    mergeNextHighlight: false,

    // Box selection (right mouse drag)
    boxSelect: {
        active: false,
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    },

    // Measure tool
    measureEnabled: false,
    // Completed measurements in the current measure session.
    // Each record is { a: {x,y}, b: {x,y} }
    measureRecords: [],
    // Click count within the current measure session; odd click starts a new record.
    measureClickCount: 0,
    measurePoints: [], // world-space points: [{x,y}, {x,y}]
    measureHover: null, // { x, y, snapped: boolean, kind: 'vertex'|'edge'|'free', layerKey?: string }
    measureSnapPx: 10,

    // WebGL
    gl: null,
    glProgram: null,
    instancedArraysExt: null,
    drawWebGLPending: false,
    layerBuffers: {},
    instanceBuffers: {},
    definitions: {},
    definitionGeometry: {},
    instanceTransforms: {},
    definitionBBoxes: {},
    bboxBuffer: null,
    spatialGrid: null,
    totalPolyCount: 0,

    // Viewport-driven streaming (WebGL + Rust)
    viewportStreaming: false,
    viewportPaddingFactor: 0.25,
    viewportDebounceMs: 80,
    viewportRequestSeq: 0,
    viewportActiveRequestId: 0,
    viewportTimer: null,

    // Snapping viewport polygon stream (measure tool)
    // We tag each request with a token so stale polygon chunks can be dropped.
    snapViewportSeq: 0,
    snapViewportTokenCurrent: null,

    // WebGL box selection: pending request info until snap polygons arrive.
    // { token: string, sel: { minX, maxX, minY, maxY } } where sel is screen-space.
    boxSelectPending: null,

    // Viewport snapshot staging (avoid flicker by swapping on EndViewport)
    viewportReceivingRequestId: 0,
    viewportStagingLayerBuffers: null,
    viewportStagingInstanceBuffers: null,
    viewportStagingInstanceTransforms: null,

    // Workers
    workerPool: [],
    searchWorker: null,
    workerRoundRobin: 0,

    // View
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    lastX: 0,
    lastY: 0,
    panZoomInstance: null,
    isInteracting: false,
    interactionTimeout: null,

    // Palette
    palette: [
        "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
        "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
        "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000",
        "#aaffc3", "#808000", "#ffd8b1", "#000075", "#808080"
    ]
};

export const elements = {
    canvas: null,
    scratchCanvas: null,
    scratchCtx: null,
    svgContainer: null,
    ctx: null,
    controls: null,
    recenterBtn: null,
    flipHBtn: null,
    flipVBtn: null,
    rotCWBtn: null,
    rotCCWBtn: null,
    rotAngleInput: null,
    cellTree: null,
    statusMsg: null,
    layersList: null,
    toggleControlsBtn: null,
    toggleConfigBtn: null,
    configPanel: null,
    engineSelect: null,
    fastModeInput: null,
    maxWorkersInput: null,
    chunkSizeInput: null,
    flowControlStepInput: null,
    useInstancingInput: null,
    viewportStreamingInput: null,
    viewportPaddingFactorInput: null,
    viewportDebounceMsInput: null,
    enableProfilingInput: null,
    fontSizeInput: null,
    portFontSizeInput: null,
    portArrowScaleInput: null,
    minZoomInput: null,
    pythonPathInput: null,
    viewContainer: null,
    layerControlHeader: null,
    toolbar: null,
    measureBtn: null,
    negativeViewBtn: null
};

export function initializeState() {
    state.vscode = window.vscode;
    state.config = window.gdsConfig || {};
    state.labelFontSize = state.config.labelFontSize || 10;
    state.portFontSize = state.config.portFontSize || 10;
    state.portArrowScale = state.config.portArrowScale || 1;
    state.currentEngine = state.config.engine || 'canvas';
    state.fastModeThreshold = state.config.fastModeThreshold || 0.5;
    state.enableProfiling = state.config.enableProfiling || false;
    state.flowControlStep = state.config.flowControlStep || 10;
    state.useInstancing = state.config.useInstancing !== undefined ? state.config.useInstancing : true;
    state.viewportStreaming = state.config.viewportStreaming !== undefined ? state.config.viewportStreaming : false;
    state.viewportPaddingFactor = typeof state.config.viewportPaddingFactor === 'number' ? state.config.viewportPaddingFactor : 0.25;
    state.viewportDebounceMs = typeof state.config.viewportDebounceMs === 'number' ? state.config.viewportDebounceMs : 80;
    state.flipState.y = state.currentEngine === 'svg' ? -1 : 1;

    // Initialize elements
    elements.canvas = document.getElementById('gds-canvas');
    elements.scratchCanvas = document.createElement('canvas');
    elements.scratchCtx = elements.scratchCanvas.getContext('2d');
    elements.svgContainer = document.getElementById('svg-container');
    elements.ctx = elements.canvas.getContext('2d');
    elements.controls = document.getElementById('controls');
    elements.recenterBtn = document.getElementById('recenter-btn');
    elements.flipHBtn = document.getElementById('flip-h-btn');
    elements.flipVBtn = document.getElementById('flip-v-btn');
    elements.rotCWBtn = document.getElementById('rot-cw-btn');
    elements.rotCCWBtn = document.getElementById('rot-ccw-btn');
    elements.rotAngleInput = document.getElementById('rot-angle-input');
    elements.cellTree = document.getElementById('cell-tree');
    elements.statusMsg = document.getElementById('status-msg');
    elements.layersList = document.getElementById('layers-list');
    elements.toggleControlsBtn = document.getElementById('toggle-controls-btn');
    elements.toggleConfigBtn = document.getElementById('toggle-config-btn');
    elements.configPanel = document.getElementById('config-panel');
    elements.engineSelect = document.getElementById('engine-select');
    elements.fastModeInput = document.getElementById('fast-mode-input');
    elements.maxWorkersInput = document.getElementById('max-workers-input');
    elements.chunkSizeInput = document.getElementById('chunk-size-input');
    elements.flowControlStepInput = document.getElementById('flow-control-step-input');
    elements.useInstancingInput = document.getElementById('use-instancing-input');
    elements.viewportStreamingInput = document.getElementById('viewport-streaming-input');
    elements.viewportPaddingFactorInput = document.getElementById('viewport-padding-factor-input');
    elements.viewportDebounceMsInput = document.getElementById('viewport-debounce-ms-input');
    elements.enableProfilingInput = document.getElementById('enable-profiling-input');
    elements.fontSizeInput = document.getElementById('font-size-input');
    elements.portFontSizeInput = document.getElementById('port-font-size-input');
    elements.portArrowScaleInput = document.getElementById('port-arrow-scale-input');
    elements.minZoomInput = document.getElementById('min-zoom-input');
    elements.pythonPathInput = document.getElementById('python-path-input');
    elements.viewContainer = document.getElementById('view-container');
    elements.layerControlHeader = document.getElementById('layer-control-header');
    elements.toolbar = document.getElementById('toolbar');
    elements.measureBtn = document.getElementById('measure-btn');
    elements.negativeViewBtn = document.getElementById('negative-view-btn');
}
