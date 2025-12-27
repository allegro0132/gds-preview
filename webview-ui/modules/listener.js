import { state, elements } from './state.js';
import { updateStatus } from './utils.js';
import { draw, drawWebGL, drawLabels } from './renderer.js';
import { updateTransform, resizeCanvas, fitView, screenToWorld } from './transform.js';

function computeViewportWorldBounds() {
    const container = elements.viewContainer;
    if (!container) return null;

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return null;

    const p1 = screenToWorld(0, 0);
    const p2 = screenToWorld(w, 0);
    const p3 = screenToWorld(w, h);
    const p4 = screenToWorld(0, h);

    let minX = Math.min(p1.x, p2.x, p3.x, p4.x);
    let maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
    let minY = Math.min(p1.y, p2.y, p3.y, p4.y);
    let maxY = Math.max(p1.y, p2.y, p3.y, p4.y);

    const vw = maxX - minX;
    const vh = maxY - minY;
    const pad = Math.max(vw, vh) * (state.viewportPaddingFactor || 0);

    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;

    return { minX, maxX, minY, maxY };
}

function scheduleViewportRequest() {
    // Only for Rust+WebGL path.
    if (!state.viewportStreaming) return;
    if (state.currentEngine !== 'webgl') return;
    if (!state.config || state.config.engineType !== 'rust') return;
    if (!state.useInstancing) return;

    if (state.viewportTimer) {
        clearTimeout(state.viewportTimer);
        state.viewportTimer = null;
    }

    state.viewportTimer = setTimeout(() => {
        const bbox = computeViewportWorldBounds();
        if (!bbox) return;

        const requestId = (state.viewportRequestSeq + 1) >>> 0;
        state.viewportRequestSeq = requestId;

        state.vscode.postMessage({
            command: 'viewport',
            requestId,
            bbox,
            layers: Array.from(state.activeLayers)
        });

        if (state.enableProfiling) {
            console.log('[prof] send viewport (debounced)', { requestId, bbox, layers: state.activeLayers.size });
        }
    }, state.viewportDebounceMs);
}

export function onInteraction() {
    state.hasUserInteracted = true;
    if (!state.isInteracting) {
        state.isInteracting = true;
    }

    if (state.interactionTimeout) {
        clearTimeout(state.interactionTimeout);
    }

    state.interactionTimeout = setTimeout(() => {
        state.isInteracting = false;
        requestAnimationFrame(draw);
        scheduleViewportRequest();
    }, 300);
}

export function findAndHighlight(x, y) {
    if (state.searchRequestId) {
        state.searchRequestId = null;
    }

    // Send search request to backend via extension
    vscode.postMessage({
        command: 'find',
        x, y,
        layers: Array.from(state.activeLayers),
        maxSteps: state.config.maxSteps,
        maxWorkers: state.config.maxWorkers
    });

    updateStatus("Searching...");
}

export function setupListeners() {
    window.addEventListener('resize', () => {
        if (state.currentEngine === 'canvas' || state.currentEngine === 'webgl') {
            resizeCanvas();
            scheduleViewportRequest();
        }
        else if (state.panZoomInstance) {
            state.panZoomInstance.resize();
            state.panZoomInstance.fit();
            state.panZoomInstance.center();
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'F2') {
            fitView();
        }
    });

    const viewContainer = elements.viewContainer;

    viewContainer.addEventListener('dblclick', e => {
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl' && state.currentEngine !== 'svg') {
            updateStatus("Highlighting not supported in this mode");
            return;
        }

        const rect = viewContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const { x: wx, y: wy } = screenToWorld(mouseX, mouseY);

        findAndHighlight(wx, wy);
    });

    viewContainer.addEventListener('mousedown', e => {
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl') return;
        state.isDragging = true;
        state.lastX = e.clientX;
        state.lastY = e.clientY;
        onInteraction();
    });

    window.addEventListener('mouseup', () => {
        state.isDragging = false;
        onInteraction();
    });

    window.addEventListener('mousemove', e => {
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl') return;
        if (state.isDragging) {
            onInteraction();
            const dx = e.clientX - state.lastX;
            const dy = e.clientY - state.lastY;
            state.lastX = e.clientX;
            state.lastY = e.clientY;
            state.offsetX += dx;
            state.offsetY += dy;
            if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
            else requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);
            scheduleViewportRequest();
        }
    });

    viewContainer.addEventListener('wheel', e => {
        // If the user is scrolling inside the Configuration panel, do not treat it as a view interaction.
        // Note: the handler is registered with capture=true on viewContainer, so we must gate it here.
        if (elements.configPanel && elements.configPanel.contains(e.target)) {
            return;
        }

        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl' && state.currentEngine !== 'svg') return;

        if (state.currentEngine === 'svg') {
            if (e.metaKey || e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                if (!state.panZoomInstance) return;

                const delta = -(e.deltaY || e.deltaX);
                if (e.metaKey) {
                    state.panZoomInstance.panBy({ x: delta, y: 0 });
                } else {
                    state.panZoomInstance.panBy({ x: 0, y: delta });
                }

                const pan = state.panZoomInstance.getPan();
                const sizes = state.panZoomInstance.getSizes();
                state.offsetX = pan.x;
                state.offsetY = pan.y;
                state.scale = sizes.realZoom;
                requestAnimationFrame(drawLabels);
            }
            return;
        }

        e.preventDefault();
        onInteraction();

        if (e.metaKey) {
            state.offsetX -= (e.deltaY || e.deltaX);
        } else if (e.shiftKey) {
            state.offsetY -= (e.deltaY || e.deltaX);
        } else {
            const zoomIntensity = 0.1;
            const delta = e.deltaY < 0 ? 1 : -1;
            const zoomFactor = Math.exp(delta * zoomIntensity);

            const rect = viewContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const worldX = (mouseX - state.offsetX) / state.scale;
            const worldY = (mouseY - state.offsetY) / -state.scale;

            state.scale *= zoomFactor;
            state.scale = Math.max(state.scale, 1e-5);

            state.offsetX = mouseX - worldX * state.scale;
            state.offsetY = mouseY - worldY * -state.scale;
        }

        if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
        else requestAnimationFrame(drawWebGL);
        requestAnimationFrame(drawLabels);
        scheduleViewportRequest();
    }, { capture: true });

    viewContainer.addEventListener('contextmenu', e => {
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl' && state.currentEngine !== 'svg') return;
        e.preventDefault();
        onInteraction();

        const rect = viewContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        if (state.currentEngine === 'svg') {
            if (!state.panZoomInstance) return;
            const dx = centerX - mouseX;
            const dy = centerY - mouseY;
            state.panZoomInstance.panBy({ x: dx, y: dy });

            const pan = state.panZoomInstance.getPan();
            const sizes = state.panZoomInstance.getSizes();
            state.offsetX = pan.x;
            state.offsetY = pan.y;
            state.scale = sizes.realZoom;
            requestAnimationFrame(drawLabels);
            return;
        }

        const worldX = (mouseX - state.offsetX) / state.scale;
        const worldY = (mouseY - state.offsetY) / -state.scale;

        state.offsetX = centerX - worldX * state.scale;
        state.offsetY = centerY - worldY * -state.scale;

        if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
        else requestAnimationFrame(drawWebGL);
        requestAnimationFrame(drawLabels);
        scheduleViewportRequest();
    });

    if (elements.layerControlHeader) {
        elements.layerControlHeader.addEventListener('dblclick', () => {
            state.allLayers.forEach(layerKey => state.activeLayers.add(layerKey));

            const checkboxes = document.querySelectorAll('#layers-list input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = true;
            });

            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);

            if (state.currentEngine === 'svg') {
                state.allLayers.forEach(key => {
                    const el = document.getElementById('layer-group-' + key);
                    if (el) el.style.display = 'block';
                });
            }
        });
    }

    elements.controls.addEventListener('click', function (event) {
        const target = event.target;
        if (target.id === 'label-color-trigger') {
            document.getElementById('label-color-picker').click();
        }
        if (target.id === 'label-color-reset') {
            state.globalLabelColor = null;
            document.getElementById('label-color-trigger').style.background = 'linear-gradient(135deg, red, orange, yellow, green, blue, indigo, violet)';
            target.style.display = 'none';
            requestAnimationFrame(drawLabels);
        }
        if (target.id === 'port-color-trigger') {
            document.getElementById('port-color-picker').click();
        }
        if (target.id === 'port-color-reset') {
            state.globalPortColor = null;
            document.getElementById('port-color-trigger').style.background = 'linear-gradient(135deg, red, orange, yellow, green, blue, indigo, violet)';
            target.style.display = 'none';
            requestAnimationFrame(drawLabels);
        }
    });

    elements.controls.addEventListener('change', function (event) {
        const target = event.target;
        if (target.id === 'cell-select') return;

        if (target.id === 'show-labels-checkbox') {
            state.showLabels = target.checked;
            requestAnimationFrame(drawLabels);
            return;
        }

        if (target.id === 'label-brightness-slider') {
            state.labelBrightness = parseFloat(target.value);
            requestAnimationFrame(drawLabels);
            return;
        }

        if (target.id === 'label-color-picker') {
            state.globalLabelColor = target.value;
            document.getElementById('label-color-trigger').style.background = state.globalLabelColor;
            document.getElementById('label-color-reset').style.display = 'inline-block';
            requestAnimationFrame(drawLabels);
            return;
        }

        if (target.id === 'show-ports-checkbox') {
            state.showPorts = target.checked;
            requestAnimationFrame(drawLabels);
            return;
        }

        if (target.id === 'port-color-picker') {
            state.globalPortColor = target.value;
            document.getElementById('port-color-trigger').style.background = state.globalPortColor;
            document.getElementById('port-color-reset').style.display = 'inline-block';
            requestAnimationFrame(drawLabels);
            return;
        }

        if (target.id === 'port-brightness-slider') {
            state.portBrightness = parseFloat(target.value);
            requestAnimationFrame(drawLabels);
            return;
        }

        const layerId = target.getAttribute('data-layer-id');

        if (target.type === 'checkbox') {
            if (target.checked) {
                state.activeLayers.add(layerId);
            } else {
                state.activeLayers.delete(layerId);
            }
            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);
            scheduleViewportRequest();
            if (state.currentEngine === 'svg') {
                const el = document.getElementById('layer-group-' + layerId);
                if (el) el.style.display = target.checked ? 'block' : 'none';
            }
        } else if (target.type === 'color') {
            state.layerColors[layerId] = target.value;
            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);
            scheduleViewportRequest();
            if (state.currentEngine === 'svg') {
                const el = document.getElementById('layer-group-' + layerId);
                if (el) {
                    el.style.color = target.value;
                    el.setAttribute('fill', target.value);
                    el.setAttribute('stroke', target.value);
                }
            }
        } else if (target && target.classList && target.classList.contains('opacity-slider')) {
            state.layerOpacities[layerId] = parseFloat(target.value);
            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);
            scheduleViewportRequest();
            if (state.currentEngine === 'svg') {
                const el = document.getElementById('layer-group-' + layerId);
                if (el) el.style.opacity = target.value;
            }
        }
    });

    elements.recenterBtn.addEventListener('click', fitView);

    if (elements.negativeViewBtn) {
        elements.negativeViewBtn.addEventListener('click', () => {
            state.isNegative = !state.isNegative;
            if (state.isNegative) {
                elements.negativeViewBtn.style.backgroundColor = 'var(--vscode-toolbar-activeBackground)';
            } else {
                elements.negativeViewBtn.style.backgroundColor = '';
            }

            state.vscode.postMessage({
                command: 'syncNegativeState',
                isNegative: state.isNegative
            });

            if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            else if (state.currentEngine === 'svg') {
                state.vscode.postMessage({
                    command: 'reloadNegative',
                    isNegative: state.isNegative
                });
            }
        });
    }

    if (elements.flipHBtn) {
        elements.flipHBtn.addEventListener('click', () => {
            state.flipState.x *= -1;
            updateTransform();
        });
    }

    if (elements.flipVBtn) {
        elements.flipVBtn.addEventListener('click', () => {
            state.flipState.y *= -1;
            updateTransform();
        });
    }

    if (elements.rotCWBtn && elements.rotAngleInput) {
        elements.rotCWBtn.addEventListener('click', () => {
            const angle = parseFloat(elements.rotAngleInput.value) || 0;
            const dir = state.flipState.x * state.flipState.y;
            state.rotationState = (state.rotationState - (angle * dir)) % 360;
            updateTransform();
        });
    }

    if (elements.rotCCWBtn && elements.rotAngleInput) {
        elements.rotCCWBtn.addEventListener('click', () => {
            const angle = parseFloat(elements.rotAngleInput.value) || 0;
            const dir = state.flipState.x * state.flipState.y;
            state.rotationState = (state.rotationState + (angle * dir)) % 360;
            updateTransform();
        });
    }

    if (elements.toggleControlsBtn) {
        elements.toggleControlsBtn.addEventListener('click', () => {
            const isCollapsed = elements.controls.style.display === 'none';
            if (isCollapsed) {
                elements.controls.style.display = 'flex';
                elements.toggleControlsBtn.textContent = '❮';
                elements.toggleControlsBtn.style.left = '0';
            } else {
                elements.controls.style.display = 'none';
                elements.toggleControlsBtn.textContent = '❯';
                elements.toggleControlsBtn.style.left = '0';
            }
            if (state.currentEngine === 'canvas' || state.currentEngine === 'webgl') {
                requestAnimationFrame(resizeCanvas);
            } else if (state.panZoomInstance) {
                state.panZoomInstance.resize();
                state.panZoomInstance.fit();
                state.panZoomInstance.center();
            }
        });
    }

    if (elements.toggleConfigBtn && elements.configPanel) {
        elements.toggleConfigBtn.addEventListener('click', () => {
            const isHidden = elements.configPanel.style.display === 'none' || elements.configPanel.style.display === '';
            if (isHidden) {
                elements.configPanel.style.display = 'block';
                elements.toggleConfigBtn.style.right = '250px';
                elements.toggleConfigBtn.style.color = '#fff';
            } else {
                elements.configPanel.style.display = 'none';
                elements.toggleConfigBtn.style.right = '0';
                elements.toggleConfigBtn.style.color = '#ccc';
            }
        });
    }

    let isDraggingToolbar = false;
    let toolbarOffsetX = 0;
    let toolbarOffsetY = 0;

    if (elements.toolbar) {
        elements.toolbar.addEventListener('dblclick', (e) => e.stopPropagation());

        elements.toolbar.addEventListener('mousedown', (e) => {
            if (e.target === elements.toolbar || (e.target && e.target.classList && e.target.classList.contains('toolbar-separator'))) {
                isDraggingToolbar = true;
                toolbarOffsetX = e.clientX - elements.toolbar.offsetLeft;
                toolbarOffsetY = e.clientY - elements.toolbar.offsetTop;
                e.preventDefault();
                e.stopPropagation();
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (isDraggingToolbar) {
                let newLeft = e.clientX - toolbarOffsetX;
                let newTop = e.clientY - toolbarOffsetY;

                const maxX = window.innerWidth - elements.toolbar.offsetWidth;
                const maxY = window.innerHeight - elements.toolbar.offsetHeight;

                newLeft = Math.max(0, Math.min(newLeft, maxX));
                newTop = Math.max(0, Math.min(newTop, maxY));

                elements.toolbar.style.left = newLeft + 'px';
                elements.toolbar.style.top = newTop + 'px';
            }
        });

        window.addEventListener('mouseup', () => {
            isDraggingToolbar = false;
        });
    }

    // Config inputs listeners
    if (elements.engineSelect) {
        elements.engineSelect.value = state.currentEngine;
        elements.engineSelect.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'renderingEngine',
                value: e.target.value
            });
        });
    }

    if (elements.fastModeInput) {
        elements.fastModeInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'fastModeThreshold',
                value: parseFloat(e.target.value)
            });
        });
    }

    if (elements.maxWorkersInput) {
        elements.maxWorkersInput.addEventListener('change', (e) => {
            const v = parseInt(e.target.value);
            if (!Number.isNaN(v)) {
                state.config.maxWorkers = v;
            }
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'maxWorkers',
                value: v
            });
        });
    }

    if (elements.chunkSizeInput) {
        elements.chunkSizeInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'chunkSize',
                value: parseInt(e.target.value)
            });
        });
    }

    if (elements.flowControlStepInput) {
        elements.flowControlStepInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'flowControlStep',
                value: parseInt(e.target.value)
            });
        });
    }

    if (elements.useInstancingInput) {
        elements.useInstancingInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'useInstancing',
                value: e.target.checked
            });
        });
    }

    if (elements.viewportStreamingInput) {
        elements.viewportStreamingInput.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            state.viewportStreaming = enabled;
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'viewportStreaming',
                value: enabled
            });
            // Enabling/disabling requires engine restart; extension will reload.
        });
    }

    if (elements.viewportPaddingFactorInput) {
        elements.viewportPaddingFactorInput.addEventListener('change', (e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) {
                state.viewportPaddingFactor = v;
            }
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'viewportPaddingFactor',
                value: v
            });
            scheduleViewportRequest();
        });
    }

    if (elements.viewportDebounceMsInput) {
        elements.viewportDebounceMsInput.addEventListener('change', (e) => {
            const v = parseInt(e.target.value);
            if (!Number.isNaN(v)) {
                state.viewportDebounceMs = v;
            }
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'viewportDebounceMs',
                value: v
            });
        });
    }

    if (elements.enableProfilingInput) {
        elements.enableProfilingInput.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            state.enableProfiling = enabled;
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'enableProfiling',
                value: enabled
            });
        });
    }

    if (elements.fontSizeInput) {
        elements.fontSizeInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'labelFontSize',
                value: parseFloat(e.target.value)
            });
        });
    }

    if (elements.portFontSizeInput) {
        elements.portFontSizeInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'portFontSize',
                value: parseFloat(e.target.value)
            });
        });
    }

    if (elements.portArrowScaleInput) {
        elements.portArrowScaleInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'portArrowScale',
                value: parseFloat(e.target.value)
            });
        });
    }

    if (elements.pythonPathInput) {
        elements.pythonPathInput.addEventListener('change', (e) => {
            state.vscode.postMessage({
                command: 'updateConfig',
                key: 'pythonPath',
                value: e.target.value
            });
        });
    }
}
