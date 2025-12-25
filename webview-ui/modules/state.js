export const state = {
    vscode: null,
    config: {},
    perfMetrics: { workerTime: 0, renderTime: 0, mainThreadParseTime: 0 },
    startTime: 0,
    pendingTasks: 0,
    pythonFinished: false,
    geometry: {},
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

    // WebGL
    gl: null,
    glProgram: null,
    instancedArraysExt: null,
    layerBuffers: {},
    instanceBuffers: {},
    definitions: {},
    definitionGeometry: {},
    instanceTransforms: {},
    definitionBBoxes: {},
    bboxBuffer: null,
    spatialGrid: null,
    totalPolyCount: 0,

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
    fontSizeInput: null,
    portFontSizeInput: null,
    portArrowScaleInput: null,
    minZoomInput: null,
    pythonPathInput: null,
    viewContainer: null,
    layerControlHeader: null,
    toolbar: null,
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
    elements.fontSizeInput = document.getElementById('font-size-input');
    elements.portFontSizeInput = document.getElementById('port-font-size-input');
    elements.portArrowScaleInput = document.getElementById('port-arrow-scale-input');
    elements.minZoomInput = document.getElementById('min-zoom-input');
    elements.pythonPathInput = document.getElementById('python-path-input');
    elements.viewContainer = document.getElementById('view-container');
    elements.layerControlHeader = document.getElementById('layer-control-header');
    elements.toolbar = document.getElementById('toolbar');
    elements.negativeViewBtn = document.getElementById('negative-view-btn');
}
