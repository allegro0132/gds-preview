import { state, initializeState, elements } from './modules/state.js';
import { setupListeners } from './modules/listener.js';
import {
    handleWorkerMessage,
    handleSearchWorkerMessage,
    handleDataUpdate,
    handleInitialize,
    handleAddLayerChunk,
    handleAddLayerChunkB64,
    connectWebSocket
} from './modules/handle.js';
import { updateStatus, checkCompletion } from './modules/utils.js';
import { draw, drawLabels } from './modules/renderer.js';
import { updateTransform } from './modules/transform.js';

// vscode is already acquired in head script
// window.vscode is used in initializeState

console.log("GDS Preview: Main Script initialized");

// Initialize State and Elements
initializeState();

// Worker Pool for Triangulation
const workerCode = state.config.workerCode;

let workerUrl;
if (state.config.workerUrl) {
    workerUrl = state.config.workerUrl;
} else if (workerCode) {
    const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
    workerUrl = URL.createObjectURL(workerBlob);
}

// Frontend only needs 1 worker now as heavy lifting is done in Rust
let maxWorkers = 1;

console.log(`Initializing worker pool with ${maxWorkers} workers`);

if (workerUrl) {
    for (let i = 0; i < maxWorkers; i++) {
        const worker = new Worker(workerUrl);
        worker.onmessage = (e) => handleWorkerMessage(e, i);
        worker.onerror = (e) => {
            console.error(`Worker ${i} error:`, e);
            updateStatus(`Worker error: ${e.message}`);
        };
        state.workerPool.push(worker);
    }
}

// Setup Event Listeners
setupListeners();

// Message Handler
window.addEventListener('message', event => {
    const message = event.data;

    const handleEngineChange = (newEngine) => {
        if (state.currentEngine === 'svg' && newEngine !== 'svg') {
            state.flipState.y *= -1;
        }
        if (state.currentEngine !== 'svg' && newEngine === 'svg') {
            state.flipState.y *= -1;
        }
        state.currentEngine = newEngine;
    };

    if (message.command === 'updateData') {
        handleEngineChange(message.engine);
        handleDataUpdate(message.data);
    } else if (message.command === 'initialize') {
        handleEngineChange(message.engine);
        handleInitialize(message.data);
    } else if (message.command === 'addLayerChunk') {
        handleAddLayerChunk(message.layerKey, message.data);
    } else if (message.command === 'addLayerChunkB64') {
        handleAddLayerChunkB64(message.layerKey, message.chunkIndex, message.totalChunks, message.data, message.type, message.cellName, message.isBinary);
    } else if (message.command === 'connect_ws') {
        connectWebSocket(message.uri);
    } else if (message.command === 'addPorts') {
        state.ports = message.ports;
        requestAnimationFrame(drawLabels);
    } else if (message.command === 'found') {
        handleSearchWorkerMessage({ data: message });
    } else if (message.command === 'status') {
        updateStatus(message.message);
        if (message.message === 'Loaded successfully') {
            state.pythonFinished = true;
            checkCompletion();
        }
    } else if (message.command === 'updateSettings') {
        if (message.fastModeThreshold !== undefined) {
            state.fastModeThreshold = message.fastModeThreshold;
            if (elements.fastModeInput) elements.fastModeInput.value = state.fastModeThreshold;
            console.log("Updated fastModeThreshold to:", state.fastModeThreshold);
        }
        if (message.labelFontSize !== undefined) {
            state.labelFontSize = message.labelFontSize;
            if (elements.fontSizeInput) elements.fontSizeInput.value = state.labelFontSize;
            console.log("Updated labelFontSize to:", state.labelFontSize);
            requestAnimationFrame(drawLabels);
        }
        if (message.portFontSize !== undefined) {
            state.portFontSize = message.portFontSize;
            if (elements.portFontSizeInput) elements.portFontSizeInput.value = state.portFontSize;
            console.log("Updated portFontSize to:", state.portFontSize);
            requestAnimationFrame(drawLabels);
        }
        if (message.portArrowScale !== undefined) {
            state.portArrowScale = message.portArrowScale;
            if (elements.portArrowScaleInput) elements.portArrowScaleInput.value = state.portArrowScale;
            console.log("Updated portArrowScale to:", state.portArrowScale);
            requestAnimationFrame(drawLabels);
        }
        if (message.maxSteps !== undefined) {
            // state.searchWorker.postMessage({ command: 'updateConfig', maxSteps: message.maxSteps });
            console.log("Updated maxSteps to:", message.maxSteps);
        }
    } else if (message.command === 'reset') {
        state.flipState = { x: 1, y: state.currentEngine === 'svg' ? -1 : 1 };
        state.rotationState = 0;
        state.highlightedPolygons = [];
        state.highlightedPath = null;
        state.hasUserInteracted = false;

        state.geometry = {};
        state.labels = {};
        state.definitions = {};
        state.instanceBuffers = {};
        state.definitionGeometry = {};
        state.instanceTransforms = {};
        state.definitionBBoxes = {};

        // state.searchWorker.postMessage({ command: 'clear' });

        updateTransform();

        if (elements.toolbar) {
            elements.toolbar.style.top = '20px';
            elements.toolbar.style.left = '20px';
        }

        state.isNegative = false;
        if (elements.negativeViewBtn) {
            elements.negativeViewBtn.style.backgroundColor = '';
        }

        requestAnimationFrame(drawLabels);
        if (state.currentEngine === 'canvas') requestAnimationFrame(draw);

        state.vscode.postMessage({ command: 'reset' });
    } else if (message.command === 'stop') {
        if (state.searchRequestId) {
            state.searchRequestId = null;
            updateStatus("Search stopped by user");
        }
        // state.searchWorker.postMessage({ command: 'stop' });
        state.vscode.postMessage({ command: 'stop' });
    }
});

// Signal ready
console.log("Sending ready message from webview script (end of script)");
if (state.vscode) {
    state.vscode.postMessage({ command: 'ready' });
} else {
    console.error("vscode API not found!");
}
