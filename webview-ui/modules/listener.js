import { state, elements } from './state.js';
import { updateStatus } from './utils.js';
import { draw, drawWebGL, drawLabels } from './renderer.js';
import { updateTransform, resizeCanvas, fitView, screenToWorld } from './transform.js';

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function closestPointOnSegment(ax, ay, bx, by, px, py) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const denom = abx * abx + aby * aby;
    if (denom <= 0) {
        return { x: ax, y: ay, t: 0 };
    }
    const t = clamp01((apx * abx + apy * aby) / denom);
    return { x: ax + t * abx, y: ay + t * aby, t };
}

function applyAxisLock(startPoint, candidatePoint, shiftKey) {
    if (!shiftKey) return candidatePoint;
    if (!startPoint || typeof startPoint.x !== 'number' || typeof startPoint.y !== 'number') return candidatePoint;
    if (!candidatePoint || typeof candidatePoint.x !== 'number' || typeof candidatePoint.y !== 'number') return candidatePoint;

    const dx = candidatePoint.x - startPoint.x;
    const dy = candidatePoint.y - startPoint.y;

    // Choose the axis that keeps the point closer to the cursor/candidate.
    if (Math.abs(dx) >= Math.abs(dy)) {
        return { ...candidatePoint, y: startPoint.y, snapped: false, kind: 'axis' };
    }
    return { ...candidatePoint, x: startPoint.x, snapped: false, kind: 'axis' };
}

function computeViewportWorldBoundsFast() {
    const container = elements.viewContainer;
    if (!container) return null;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return null;
    const p1 = screenToWorld(0, 0);
    const p2 = screenToWorld(w, 0);
    const p3 = screenToWorld(w, h);
    const p4 = screenToWorld(0, h);
    const minX = Math.min(p1.x, p2.x, p3.x, p4.x);
    const maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
    const minY = Math.min(p1.y, p2.y, p3.y, p4.y);
    const maxY = Math.max(p1.y, p2.y, p3.y, p4.y);
    return { minX, maxX, minY, maxY };
}

function polyIterVertices(poly) {
    const isFlat = poly instanceof Float32Array;
    const n = isFlat ? poly.length / 2 : poly.length;
    return { isFlat, n };
}

function bboxIntersects(b, minX, minY, maxX, maxY) {
    if (!b) return true;
    return !(b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY);
}

function findSnapPoint(mouseScreenX, mouseScreenY) {
    const mouseWorld = screenToWorld(mouseScreenX, mouseScreenY);

    const geom = (state.currentEngine === 'webgl' && state.snapGeometry && Object.keys(state.snapGeometry).length > 0)
        ? state.snapGeometry
        : state.geometry;

    // If we have no polygon geometry, snapping is not possible; fall back to free point.
    if (!geom || Object.keys(geom).length === 0) {
        return { x: mouseWorld.x, y: mouseWorld.y, snapped: false, kind: 'free' };
    }

    const snapPx = state.measureSnapPx || 10;
    const scale = Math.max(state.scale || 1e-9, 1e-9);
    const snapWorld = snapPx / scale;

    const vb = computeViewportWorldBoundsFast();
    const vMinX = vb ? vb.minX - snapWorld : -Infinity;
    const vMaxX = vb ? vb.maxX + snapWorld : Infinity;
    const vMinY = vb ? vb.minY - snapWorld : -Infinity;
    const vMaxY = vb ? vb.maxY + snapWorld : Infinity;

    const snapDist2 = (snapWorld * snapWorld);
    let bestVertex = null;
    let bestVertexDist2 = snapDist2;
    let bestEdge = null;
    let bestEdgeDist2 = snapDist2;

    // Prefer visible layers only.
    for (const layerKey of state.activeLayers) {
        const polys = geom[layerKey];
        if (!polys || polys.length === 0) continue;

        for (const poly of polys) {
            if (poly && poly.bbox && !bboxIntersects(poly.bbox, vMinX, vMinY, vMaxX, vMaxY)) continue;

            const { isFlat, n } = polyIterVertices(poly);
            if (n < 2) continue;

            // Vertex snap (higher priority than edge)
            for (let i = 0; i < n; i++) {
                const vx = isFlat ? poly[i * 2] : poly[i][0];
                const vy = isFlat ? poly[i * 2 + 1] : poly[i][1];
                const dx = vx - mouseWorld.x;
                const dy = vy - mouseWorld.y;
                const d2 = dx * dx + dy * dy;
                if (d2 <= bestVertexDist2) {
                    bestVertexDist2 = d2;
                    bestVertex = { x: vx, y: vy, snapped: true, kind: 'vertex', layerKey };
                    if (bestVertexDist2 === 0) return bestVertex;
                }
            }

            // Edge snap (used only when no vertex is within threshold)
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                const ax = isFlat ? poly[i * 2] : poly[i][0];
                const ay = isFlat ? poly[i * 2 + 1] : poly[i][1];
                const bx = isFlat ? poly[j * 2] : poly[j][0];
                const by = isFlat ? poly[j * 2 + 1] : poly[j][1];
                const cp = closestPointOnSegment(ax, ay, bx, by, mouseWorld.x, mouseWorld.y);
                const dx = cp.x - mouseWorld.x;
                const dy = cp.y - mouseWorld.y;
                const d2 = dx * dx + dy * dy;
                if (d2 <= bestEdgeDist2) {
                    bestEdgeDist2 = d2;
                    bestEdge = { x: cp.x, y: cp.y, snapped: true, kind: 'edge', layerKey };
                    if (bestEdgeDist2 === 0) return bestEdge;
                }
            }
        }
    }

    // Vertex has stronger influence than edge:
    // if any vertex is within the snap radius, prefer the closest vertex.
    if (bestVertex) return bestVertex;
    if (bestEdge) return bestEdge;
    return { x: mouseWorld.x, y: mouseWorld.y, snapped: false, kind: 'free' };
}

function setMeasureEnabled(enabled) {
    const prev = !!state.measureEnabled;
    state.measureEnabled = !!enabled;

    if (!state.measureEnabled) {
        // Closing measure: clear all records and snap cache.
        state.measureClickCount = 0;
        state.measureRecords = [];
        state.measurePoints = [];
        state.measureHover = null;

        state.snapGeometry = {};
        state.snapViewportTokenCurrent = null;
    } else if (!prev) {
        // Fresh measure session.
        state.measureClickCount = 0;
        state.measureRecords = [];
        state.measurePoints = [];
        state.measureHover = null;
    }

    if (elements.measureBtn) {
        elements.measureBtn.style.backgroundColor = state.measureEnabled ? 'var(--vscode-toolbar-activeBackground)' : '';
    }

    if (state.measureEnabled) {
        // Warn if current engine likely has no polygon geometry.
        if (state.currentEngine === 'webgl' && (!state.snapGeometry || Object.keys(state.snapGeometry).length === 0)) {
            updateStatus('Measure enabled. Snapping needs polygon geometry.');
        } else {
            updateStatus('Measure enabled: click to add measurements (snaps to vertex/edge). Esc clears current.');
        }
    } else {
        updateStatus('Measure disabled');
    }

    // Pull fresh viewport polygons immediately when enabling measure in WebGL+Rust.
    scheduleViewportRequest();

    requestAnimationFrame(drawLabels);
}

function clearMeasureCurrent() {
    state.measurePoints = [];
    state.measureHover = null;
    requestAnimationFrame(drawLabels);
}

function handleMeasureClick(mouseScreenX, mouseScreenY, shiftKey) {
    const snap = findSnapPoint(mouseScreenX, mouseScreenY);
    const p0 = { x: snap.x, y: snap.y };

    if (!state.measurePoints) state.measurePoints = [];
    if (!state.measureRecords) state.measureRecords = [];

    state.measureClickCount = (state.measureClickCount || 0) + 1;

    // Odd click starts a new record.
    if ((state.measureClickCount % 2) === 1) {
        state.measurePoints = [p0];
        requestAnimationFrame(drawLabels);
        return;
    }

    // Even click completes the current record.
    const a = state.measurePoints[0];
    const p = applyAxisLock(a, p0, !!shiftKey);
    if (a && typeof a.x === 'number' && typeof a.y === 'number') {
        state.measureRecords.push({ a, b: p });
    }
    state.measurePoints = [];
    requestAnimationFrame(drawLabels);
}

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
    // Rust+WebGL path.
    // - When viewportStreaming is enabled, this drives rendering snapshots.
    // - When measureEnabled is true, this requests viewport polygons for snapping (snapPolygons).
    if (state.currentEngine !== 'webgl') return;
    if (!state.config || state.config.engineType !== 'rust') return;

    const wantRenderViewport = !!state.viewportStreaming;
    const wantSnapViewport = !!state.measureEnabled;
    if (!wantRenderViewport && !wantSnapViewport) return;

    // Rendering viewport streaming requires instancing; snapping does not.
    if (wantRenderViewport && !state.useInstancing) return;

    if (state.viewportTimer) {
        clearTimeout(state.viewportTimer);
        state.viewportTimer = null;
    }

    state.viewportTimer = setTimeout(() => {
        const bbox = computeViewportWorldBounds();
        if (!bbox) return;

        const requestId = (state.viewportRequestSeq + 1) >>> 0;
        state.viewportRequestSeq = requestId;

        // When requesting snap polygons, generate a new token so stale chunks can be dropped.
        // IMPORTANT: we update the current token immediately (before any new data arrives)
        // so any still-in-flight chunks from the previous token can be ignored without parsing.
        const snapToken = wantSnapViewport ? `__snap__:${((state.snapViewportSeq + 1) >>> 0)}` : null;
        if (wantSnapViewport) {
            state.snapViewportSeq = (state.snapViewportSeq + 1) >>> 0;
            state.snapViewportTokenCurrent = snapToken;
            state.snapGeometry = {};
        }

        state.vscode.postMessage({
            command: 'viewport',
            requestId,
            bbox,
            layers: Array.from(state.activeLayers),
            snapPolygons: wantSnapViewport,
            snapToken
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

        if (e.key === 'Escape') {
            if (state.measureEnabled) {
                if (state.measurePoints && state.measurePoints.length > 0) {
                    clearMeasureCurrent();
                    updateStatus('Measure current cleared');
                }
            }
        }

        if (e.key === 'm' || e.key === 'M') {
            setMeasureEnabled(!state.measureEnabled);
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

        // In measure mode, a left click places a point (snapped if possible) and should not start a pan-drag.
        if (state.measureEnabled && e.button === 0) {
            const rect = viewContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            handleMeasureClick(mouseX, mouseY, e.shiftKey);
            e.preventDefault();
            e.stopPropagation();
            return;
        }

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

    // Measure hover tracking (runs only when enabled)
    viewContainer.addEventListener('mousemove', e => {
        if (!state.measureEnabled) return;
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl') return;

        const rect = viewContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const hover = findSnapPoint(mouseX, mouseY);
        if (state.measurePoints && state.measurePoints.length === 1) {
            state.measureHover = applyAxisLock(state.measurePoints[0], hover, e.shiftKey);
        } else {
            state.measureHover = hover;
        }
        requestAnimationFrame(drawLabels);
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

    if (elements.measureBtn) {
        elements.measureBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setMeasureEnabled(!state.measureEnabled);
        });
    }

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
