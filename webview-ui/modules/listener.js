import { state, elements } from './state.js';
import { updateStatus } from './utils.js';
import { draw, drawWebGL, drawLabels } from './renderer.js';
import { updateTransform, resizeCanvas, fitView, screenToWorld, worldToScreen } from './transform.js';

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
        return {
            ...candidatePoint,
            y: startPoint.y,
            // Preserve snapping state so UI cues (e.g. hollow ring cursor/marker) still reflect snapping.
            snapped: !!candidatePoint.snapped,
            kind: candidatePoint.snapped ? candidatePoint.kind : 'axis',
        };
    }
    return {
        ...candidatePoint,
        x: startPoint.x,
        snapped: !!candidatePoint.snapped,
        kind: candidatePoint.snapped ? candidatePoint.kind : 'axis',
    };
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

export function pickAndHighlight(x, y) {
    // Send a point-pick request to backend (single polygon only).
    vscode.postMessage({
        command: 'pick',
        x, y,
        layers: Array.from(state.activeLayers),
    });

    updateStatus('Picking...');
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

    const isEditableTarget = (t) => {
        const el = t;
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return !!el.isContentEditable;
    };

    const roundNum = (n) => {
        if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
        const r = Math.round(n);
        if (Math.abs(n - r) < 1e-9) return r;
        return Number(n.toFixed(9));
    };

    const buildKLayoutClipboardTextV2 = (highlightItems) => {
        // highlightItems: Array<{layerKey: string|null, points: Array<[x,y]>}>
        const payload = {
            version: 2,
            polygons: [],
        };

        for (const it of highlightItems) {
            if (!it || !Array.isArray(it.points) || it.points.length < 3) continue;
            const pts = it.points
                .filter(p => Array.isArray(p) && p.length >= 2)
                .map(p => [roundNum(p[0]), roundNum(p[1])]);
            if (pts.length < 3) continue;
            payload.polygons.push({
                layerKey: (typeof it.layerKey === 'string' && it.layerKey.length > 0) ? it.layerKey : null,
                points: pts,
            });
        }

        // The magic header allows a KLayout macro to safely detect our payload.
        return [
            '# gds-preview: polygons v2',
            '# JSON payload. Use klayout/paste_gds_preview_polygons.py to paste as shapes.',
            JSON.stringify(payload),
        ].join('\n');
    };

    const copyHighlightedToClipboard = async () => {
        const polys = state.highlightedPolygons;
        if (!Array.isArray(polys) || polys.length === 0) {
            updateStatus('Nothing highlighted to copy');
            return;
        }

        const text = buildKLayoutClipboardTextV2(polys);
        if (!text) {
            updateStatus('Nothing highlighted to copy');
            return;
        }

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                updateStatus(`Copied ${polys.length} polygon(s) to clipboard (KLayout)`);
                return;
            }
        } catch (_) {
            // Fall back to VS Code extension clipboard.
        }

        if (state.vscode && state.vscode.postMessage) {
            state.vscode.postMessage({ command: 'copyToClipboard', text, count: polys.length });
            updateStatus(`Copying ${polys.length} polygon(s) to clipboard...`);
        } else {
            updateStatus('Clipboard copy failed: VS Code API unavailable');
        }
    };

    window.addEventListener('keydown', (e) => {
        // Do not hijack common shortcuts while typing in inputs.
        if (isEditableTarget(e.target)) return;

        // Copy highlighted polygon(s) for KLayout.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'c') {
            e.preventDefault();
            void copyHighlightedToClipboard();
            return;
        }

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

    // Right-mouse box selection state
    let boxSelectActive = false;
    let boxSelectStart = null; // {x,y} in view container coords
    let boxSelectAdditive = false;
    let boxSelectHasMoved = false;
    let suppressNextContextMenuUntil = 0;

    const polyItemKey = (it) => {
        if (!it || !Array.isArray(it.points)) return '';
        const lk = typeof it.layerKey === 'string' ? it.layerKey : '';
        // Note: points are already nested [x,y]. Use a simple stable string key.
        return lk + ':' + it.points.map(p => `${p[0]},${p[1]}`).join(';');
    };

    const mergeHighlightItems = (existing, incoming) => {
        const out = [];
        const seen = new Set();
        const add = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const it of arr) {
                if (!it || !Array.isArray(it.points) || it.points.length < 3) continue;
                const k = polyItemKey(it);
                if (!k || seen.has(k)) continue;
                seen.add(k);
                out.push(it);
            }
        };
        add(existing);
        add(incoming);
        return out;
    };

    const getMouseInView = (clientX, clientY) => {
        const rect = viewContainer.getBoundingClientRect();
        return {
            rect,
            x: clientX - rect.left,
            y: clientY - rect.top,
        };
    };

    const setBoxSelectRect = (x0, y0, x1, y1) => {
        if (!state.boxSelect) {
            state.boxSelect = { active: false, x0: 0, y0: 0, x1: 0, y1: 0 };
        }
        state.boxSelect.active = true;
        state.boxSelect.x0 = x0;
        state.boxSelect.y0 = y0;
        state.boxSelect.x1 = x1;
        state.boxSelect.y1 = y1;
    };

    const clearBoxSelectRect = () => {
        if (!state.boxSelect) return;
        state.boxSelect.active = false;
    };

    const getPolyBBox = (poly) => {
        if (poly && poly.bbox) return poly.bbox;

        const { isFlat, n } = polyIterVertices(poly);
        if (!n || n <= 0) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            const vx = isFlat ? poly[i * 2] : poly[i][0];
            const vy = isFlat ? poly[i * 2 + 1] : poly[i][1];
            if (vx < minX) minX = vx;
            if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy;
            if (vy > maxY) maxY = vy;
        }
        const bbox = { minX, minY, maxX, maxY };
        poly.bbox = bbox;
        return bbox;
    };

    const screenBboxFromWorldBbox = (b) => {
        // Compute a conservative screen-space bbox of the world-space bbox rectangle.
        const c1 = worldToScreen(b.minX, b.minY);
        const c2 = worldToScreen(b.minX, b.maxY);
        const c3 = worldToScreen(b.maxX, b.minY);
        const c4 = worldToScreen(b.maxX, b.maxY);
        const xs = [c1.x, c2.x, c3.x, c4.x];
        const ys = [c1.y, c2.y, c3.y, c4.y];
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        };
    };

    const rectsIntersect = (a, b) => {
        return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
    };

    const polyFullyInsideScreenRect = (poly, sel) => {
        const { isFlat, n } = polyIterVertices(poly);
        if (n < 3) return false;
        for (let i = 0; i < n; i++) {
            const wx = isFlat ? poly[i * 2] : poly[i][0];
            const wy = isFlat ? poly[i * 2 + 1] : poly[i][1];
            const s = worldToScreen(wx, wy);
            if (s.x < sel.minX || s.x > sel.maxX || s.y < sel.minY || s.y > sel.maxY) {
                return false;
            }
        }
        return true;
    };

    const toNestedPoints = (poly) => {
        const { isFlat, n } = polyIterVertices(poly);
        if (!n || n <= 0) return null;
        if (!isFlat) return poly;
        const pts = [];
        for (let i = 0; i < n; i++) {
            pts.push([poly[i * 2], poly[i * 2 + 1]]);
        }
        return pts;
    };

    const finalizeBoxSelect = (x0, y0, x1, y1, additive) => {
        const sel = {
            minX: Math.min(x0, x1),
            maxX: Math.max(x0, x1),
            minY: Math.min(y0, y1),
            maxY: Math.max(y0, y1),
        };

        const w = sel.maxX - sel.minX;
        const h = sel.maxY - sel.minY;
        const CLICK_EPS = 3;
        if (w < CLICK_EPS && h < CLICK_EPS) {
            // Treat tiny drags as a right-click pick (single polygon).
            const { x: wx, y: wy } = screenToWorld(x1, y1);
            state.mergeNextHighlight = !!additive;
            pickAndHighlight(wx, wy);
            return;
        }

        // WebGL+Rust: polygon data may not be present in the webview.
        // Request snap polygons for the selection bbox from the backend (only the box area).
        if (state.currentEngine === 'webgl' && state.config && state.config.engineType === 'rust') {
            const c1 = screenToWorld(sel.minX, sel.minY);
            const c2 = screenToWorld(sel.maxX, sel.minY);
            const c3 = screenToWorld(sel.maxX, sel.maxY);
            const c4 = screenToWorld(sel.minX, sel.maxY);
            const bbox = {
                minX: Math.min(c1.x, c2.x, c3.x, c4.x),
                maxX: Math.max(c1.x, c2.x, c3.x, c4.x),
                minY: Math.min(c1.y, c2.y, c3.y, c4.y),
                maxY: Math.max(c1.y, c2.y, c3.y, c4.y),
            };
            if (![bbox.minX, bbox.maxX, bbox.minY, bbox.maxY].every(Number.isFinite)) {
                updateStatus('Box select: invalid bbox');
                return;
            }

            const requestId = (state.viewportRequestSeq + 1) >>> 0;
            state.viewportRequestSeq = requestId;

            const snapToken = `__snap__:${((state.snapViewportSeq + 1) >>> 0)}`;
            state.snapViewportSeq = (state.snapViewportSeq + 1) >>> 0;
            state.snapViewportTokenCurrent = snapToken;
            state.snapGeometry = {};

            state.boxSelectPending = { token: snapToken, sel, additive: !!additive };
            updateStatus('Box select: requesting polygons...');
            state.vscode.postMessage({
                command: 'viewportSnap',
                requestId,
                bbox,
                layers: Array.from(state.activeLayers),
                snapPolygons: true,
                snapToken,
            });
            return;
        }

        const geom = (state.currentEngine === 'webgl' && state.snapGeometry && Object.keys(state.snapGeometry).length > 0)
            ? state.snapGeometry
            : state.geometry;

        if (!geom || Object.keys(geom).length === 0) {
            updateStatus('Box select: no polygon geometry available');
            return;
        }

        const selected = [];

        for (const layerKey of state.activeLayers) {
            const polys = geom[layerKey];
            if (!polys || polys.length === 0) continue;
            for (const poly of polys) {
                if (!poly) continue;

                // Fast reject using transformed bbox intersection.
                const b = getPolyBBox(poly);
                if (b) {
                    const sb = screenBboxFromWorldBbox(b);
                    if (!rectsIntersect(sb, sel)) continue;
                }

                if (!polyFullyInsideScreenRect(poly, sel)) continue;
                const pts = toNestedPoints(poly);
                if (!pts || pts.length < 3) continue;
                selected.push({ layerKey, points: pts });
            }
        }

        state.highlightedPolygons = additive
            ? mergeHighlightItems(state.highlightedPolygons, selected)
            : selected;
        const path = new Path2D();
        for (const it of state.highlightedPolygons) {
            const poly = it && it.points;
            if (!poly || poly.length < 2) continue;
            path.moveTo(poly[0][0], poly[0][1]);
            for (let i = 1; i < poly.length; i++) {
                path.lineTo(poly[i][0], poly[i][1]);
            }
            path.closePath();
        }
        state.highlightedPath = state.highlightedPolygons.length > 0 ? path : null;

        updateStatus(`Box selected ${state.highlightedPolygons.length} polygon(s)`);
        requestAnimationFrame(drawLabels);
    };

    const isUiOverlayTarget = (t) => {
        if (!t) return false;
        if (elements.toolbar && elements.toolbar.contains(t)) return true;
        if (elements.configPanel && elements.configPanel.contains(t)) return true;
        if (elements.toggleControlsBtn && (elements.toggleControlsBtn === t || elements.toggleControlsBtn.contains(t))) return true;
        if (elements.toggleConfigBtn && (elements.toggleConfigBtn === t || elements.toggleConfigBtn.contains(t))) return true;
        return false;
    };

    viewContainer.addEventListener('dblclick', e => {
        if (isUiOverlayTarget(e.target)) return;
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl' && state.currentEngine !== 'svg') {
            updateStatus("Highlighting not supported in this mode");
            return;
        }

        const rect = viewContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const { x: wx, y: wy } = screenToWorld(mouseX, mouseY);

        // Additive highlight: merge next result into existing highlight set.
        state.mergeNextHighlight = !!(e.ctrlKey || e.metaKey);

        findAndHighlight(wx, wy);
    });

    viewContainer.addEventListener('mousedown', e => {
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl') return;

        // Do not treat toolbar/config interactions as view interactions.
        if (isUiOverlayTarget(e.target)) return;

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

        // Right-mouse drag draws a selection box.
        if (e.button === 2) {
            const { x, y } = getMouseInView(e.clientX, e.clientY);
            boxSelectActive = true;
            boxSelectStart = { x, y };
            boxSelectAdditive = !!(e.ctrlKey || e.metaKey);
            boxSelectHasMoved = false;
            suppressNextContextMenuUntil = performance.now() + 1000;
            onInteraction();
            e.preventDefault();
            e.stopPropagation();
            requestAnimationFrame(drawLabels);
            return;
        }

        state.isDragging = true;
        state.lastX = e.clientX;
        state.lastY = e.clientY;
        onInteraction();
    });

    window.addEventListener('mouseup', (e) => {
        if (boxSelectActive) {
            const { x, y } = getMouseInView(e.clientX, e.clientY);
            const x0 = boxSelectStart ? boxSelectStart.x : x;
            const y0 = boxSelectStart ? boxSelectStart.y : y;

            const additive = boxSelectAdditive;
            const hasMoved = boxSelectHasMoved;

            boxSelectActive = false;
            boxSelectStart = null;
            boxSelectAdditive = false;
            boxSelectHasMoved = false;
            clearBoxSelectRect();
            requestAnimationFrame(drawLabels);

            // If the user didn't actually drag, treat as a right-click pick.
            // This avoids the "small bbox" failure mode for very large polygons.
            if (!hasMoved) {
                const { x: wx, y: wy } = screenToWorld(x, y);
                state.mergeNextHighlight = !!additive;
                pickAndHighlight(wx, wy);
                return;
            }

            finalizeBoxSelect(x0, y0, x, y, additive);
            return;
        }

        state.isDragging = false;
        onInteraction();
    });

    window.addEventListener('mousemove', e => {
        if (state.currentEngine !== 'canvas' && state.currentEngine !== 'webgl') return;

        if (boxSelectActive) {
            const { x, y } = getMouseInView(e.clientX, e.clientY);
            const x0 = boxSelectStart ? boxSelectStart.x : x;
            const y0 = boxSelectStart ? boxSelectStart.y : y;
            const DRAG_EPS = 4;
            if (!boxSelectHasMoved) {
                const dx = x - x0;
                const dy = y - y0;
                if ((dx * dx + dy * dy) >= (DRAG_EPS * DRAG_EPS)) {
                    boxSelectHasMoved = true;
                    setBoxSelectRect(x0, y0, x, y);
                }
            } else {
                setBoxSelectRect(x0, y0, x, y);
            }
            requestAnimationFrame(drawLabels);
            return;
        }

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
        if (boxSelectActive) return;

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
        if (suppressNextContextMenuUntil && performance.now() <= suppressNextContextMenuUntil) {
            suppressNextContextMenuUntil = 0;
            return;
        }
        onInteraction();

        // Right-click (contextmenu) is a point-pick highlight.
        const rect = viewContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const { x: wx, y: wy } = screenToWorld(mouseX, mouseY);
        state.mergeNextHighlight = !!(e.ctrlKey || e.metaKey);
        pickAndHighlight(wx, wy);
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
