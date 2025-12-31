import { state, elements } from './state.js';
import { updateStatus, checkCompletion } from './utils.js';
import { draw, drawWebGL, drawLabels, setupCanvasMode, setupSvgMode, setupWebGLMode } from './renderer.js';
import { updateTransform, resizeCanvas, fitView, screenToWorld, worldToScreen } from './transform.js';

let boxSelectFinalizeTimer = null;

export function cancelHighlightedPathBuild() {
    if (state.highlightedPathBuild) {
        state.highlightedPathBuild.cancelled = true;
        state.highlightedPathBuild = null;
    }
}

export function stopHighlightedPathBuild() {
    const build = state.highlightedPathBuild;
    if (!build) return false;

    // Freeze at the current partial path and stop further work.
    state.highlightedPath = build.path || null;
    build.cancelled = true;
    state.highlightedPathBuild = null;
    requestAnimationFrame(drawLabels);
    return true;
}

export function scheduleHighlightedPathBuild(items, reason) {
    cancelHighlightedPathBuild();

    if (!Array.isArray(items) || items.length === 0) {
        state.highlightedPath = null;
        return;
    }

    const build = {
        cancelled: false,
        idx: 0,
        path: new Path2D(),
        total: items.length,
        startedAtMs: performance.now(),
        lastDrawAtMs: 0,
        reason: reason || 'highlight',
    };
    state.highlightedPath = null;
    state.highlightedPathBuild = build;

    const step = () => {
        if (build.cancelled || state.highlightedPathBuild !== build) return;
        const t0 = performance.now();

        // Time-sliced build: aim to keep each chunk under ~8ms.
        const BUDGET_MS = 8;
        while (build.idx < build.total) {
            const it = items[build.idx];
            build.idx += 1;
            const poly = it && it.points;
            if (!poly || poly.length < 2) continue;
            build.path.moveTo(poly[0][0], poly[0][1]);
            for (let i = 1; i < poly.length; i++) build.path.lineTo(poly[i][0], poly[i][1]);
            build.path.closePath();

            if ((performance.now() - t0) >= BUDGET_MS) break;
        }

        // Keep showing partial path while building, but throttle redraws.
        const now = performance.now();
        if (build.idx >= build.total || (now - build.lastDrawAtMs) > 50) {
            build.lastDrawAtMs = now;
            requestAnimationFrame(drawLabels);
        }

        if (build.idx >= build.total) {
            state.highlightedPath = build.path;
            state.highlightedPathBuild = null;
            if (state.enableProfiling) {
                try {
                    console.log('[prof] highlightedPath build done', {
                        reason: build.reason,
                        items: build.total,
                        msTotal: performance.now() - build.startedAtMs,
                    });
                } catch (_) { }
            }
            return;
        }

        if (state.enableProfiling && (build.idx % 5000) < 50) {
            try {
                console.log('[prof] highlightedPath build progress', {
                    reason: build.reason,
                    done: build.idx,
                    total: build.total,
                    msSoFar: performance.now() - build.startedAtMs,
                });
            } catch (_) { }
        }

        requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
}

function finalizeBoxSelectDirectFromSnap(token) {
    const pending = state.boxSelectPending;
    if (!pending || pending.token !== token) return;

    const t0 = performance.now();

    const additive = !!pending.additive;
    const selected = [];

    const normCoord = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
        return Math.round(v * 1e6) / 1e6;
    };
    const polyItemKey = (it) => {
        if (!it) return '';
        if (Array.isArray(it.polyId) && it.polyId.length === 2) {
            return `id:${it.polyId[0]},${it.polyId[1]}`;
        }
        if (!Array.isArray(it.points)) return '';
        const lk = typeof it.layerKey === 'string' ? it.layerKey : '';
        return lk + ':' + it.points.map(pt => `${normCoord(pt[0])},${normCoord(pt[1])}`).join(';');
    };
    const mergeItems = (existing, incoming) => {
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

    for (const layerKey of state.activeLayers) {
        const polys = state.snapGeometryViewport ? state.snapGeometryViewport[layerKey] : null;
        if (!polys || polys.length === 0) continue;
        for (const poly of polys) {
            if (!(poly instanceof Float32Array)) continue;
            if (!poly.polyId) continue;
            const pts = [];
            for (let i = 0; i < poly.length; i += 2) pts.push([poly[i], poly[i + 1]]);
            selected.push({ layerKey, points: pts, polyId: poly.polyId });
        }
    }

    const tConverted = performance.now();

    state.highlightedPolygons = additive
        ? mergeItems(state.highlightedPolygons, selected)
        : selected;

    // WebGL+Rust: backend owns highlight rendering; push polyId set and skip Path2D.
    postHighlightUpdate('boxSelect');

    if (!isWebglRust()) {
        // For huge selections, build Path2D incrementally to avoid freezing the UI.
        const LARGE_HIGHLIGHT_THRESHOLD = 5000;
        if (state.highlightedPolygons.length > LARGE_HIGHLIGHT_THRESHOLD) {
            scheduleHighlightedPathBuild(state.highlightedPolygons, 'boxSelect');
        } else {
            cancelHighlightedPathBuild();
            const path = new Path2D();
            for (const it of state.highlightedPolygons) {
                const poly = it && it.points;
                if (!poly || poly.length < 2) continue;
                path.moveTo(poly[0][0], poly[0][1]);
                for (let i = 1; i < poly.length; i++) path.lineTo(poly[i][0], poly[i][1]);
                path.closePath();
            }
            state.highlightedPath = state.highlightedPolygons.length > 0 ? path : null;
        }
    } else {
        cancelHighlightedPathBuild();
        state.highlightedPath = null;
    }
    state.boxSelectPending = null;

    const tDone = performance.now();

    if (state.enableProfiling) {
        try {
            console.log('[prof] boxSelect finalize (backendFinal)', {
                token,
                receivedPolys: pending.receivedPolys ?? null,
                selectedCount: state.highlightedPolygons.length,
                msConvert: tConverted - t0,
                msPath: tDone - tConverted,
                msTotal: tDone - t0,
                msSinceRequest: (typeof pending.startedAtMs === 'number') ? (tDone - pending.startedAtMs) : null,
            });
        } catch (_) { }
    }

    updateStatus(`Box selected ${state.highlightedPolygons.length} polygon(s)`);
    requestAnimationFrame(drawLabels);
}

function maybeFinalizeBoxSelectFromSnap(token) {
    const pending = state.boxSelectPending;
    if (!pending || !pending.token || pending.token !== token) return;

    if (boxSelectFinalizeTimer) {
        clearTimeout(boxSelectFinalizeTimer);
        boxSelectFinalizeTimer = null;
    }

    // Debounce until snap chunks stop arriving.
    boxSelectFinalizeTimer = setTimeout(() => {
        boxSelectFinalizeTimer = null;
        const p = state.boxSelectPending;
        if (!p || p.token !== token || !p.sel) return;

        const sel = p.sel;
        const additive = !!p.additive;
        const selected = [];

        const normCoord = (v) => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
            return Math.round(v * 1e6) / 1e6;
        };

        const polyItemKey = (it) => {
            if (!it) return '';
            if (Array.isArray(it.polyId) && it.polyId.length === 2) {
                return `id:${it.polyId[0]},${it.polyId[1]}`;
            }
            if (!Array.isArray(it.points)) return '';
            const lk = typeof it.layerKey === 'string' ? it.layerKey : '';
            return lk + ':' + it.points.map(pt => `${normCoord(pt[0])},${normCoord(pt[1])}`).join(';');
        };
        const mergeItems = (existing, incoming) => {
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

        for (const layerKey of state.activeLayers) {
            const polys = state.snapGeometryViewport ? state.snapGeometryViewport[layerKey] : null;
            if (!polys || polys.length === 0) continue;

            for (const poly of polys) {
                if (!poly) continue;
                const isFlat = poly instanceof Float32Array;
                const n = isFlat ? (poly.length / 2) : poly.length;
                if (n < 3) continue;

                let inside = true;
                for (let i = 0; i < n; i++) {
                    const wx = isFlat ? poly[i * 2] : poly[i][0];
                    const wy = isFlat ? poly[i * 2 + 1] : poly[i][1];
                    const s = worldToScreen(wx, wy);
                    if (s.x < sel.minX || s.x > sel.maxX || s.y < sel.minY || s.y > sel.maxY) {
                        inside = false;
                        break;
                    }
                }
                if (!inside) continue;

                // Convert to nested points for downstream features (copy-to-KLayout expects nested arrays).
                if (isFlat) {
                    // v2-only: viewport snap polygons must carry polyId.
                    if (!poly.polyId) continue;
                    const pts = [];
                    for (let i = 0; i < poly.length; i += 2) pts.push([poly[i], poly[i + 1]]);
                    selected.push({ layerKey, points: pts, polyId: poly.polyId });
                } else {
                    // This cache is expected to store Float32Array polygons only.
                    continue;
                }
            }
        }

        state.highlightedPolygons = additive
            ? mergeItems(state.highlightedPolygons, selected)
            : selected;

        const LARGE_HIGHLIGHT_THRESHOLD = 5000;
        if (state.highlightedPolygons.length > LARGE_HIGHLIGHT_THRESHOLD) {
            scheduleHighlightedPathBuild(state.highlightedPolygons, 'boxSelect');
        } else {
            cancelHighlightedPathBuild();
            const path = new Path2D();
            for (const it of state.highlightedPolygons) {
                const poly = it && it.points;
                if (!poly || poly.length < 2) continue;
                path.moveTo(poly[0][0], poly[0][1]);
                for (let i = 1; i < poly.length; i++) path.lineTo(poly[i][0], poly[i][1]);
                path.closePath();
            }
            state.highlightedPath = state.highlightedPolygons.length > 0 ? path : null;
        }
        state.boxSelectPending = null;

        updateStatus(`Box selected ${state.highlightedPolygons.length} polygon(s)`);
        requestAnimationFrame(drawLabels);
    }, 60);
}

function ensureSnapLayer(layerKey) {
    if (!state.snapGeometry) state.snapGeometry = {};
    if (!state.snapGeometry[layerKey]) state.snapGeometry[layerKey] = [];
    return state.snapGeometry[layerKey];
}

function ensureViewportSnapLayer(layerKey) {
    if (!state.snapGeometryViewport) state.snapGeometryViewport = {};
    if (!state.snapGeometryViewport[layerKey]) state.snapGeometryViewport[layerKey] = [];
    return state.snapGeometryViewport[layerKey];
}

function pushSnapPolys(layerKey, polys) {
    if (!polys || polys.length === 0) return;
    const target = ensureSnapLayer(layerKey);

    // Keep this cache bounded. For viewport streaming, we clear per snapshot anyway.
    // For non-streaming flows, cap to prevent unbounded memory growth.
    const MAX_PER_LAYER = 20000;

    for (const poly of polys) {
        // Convert nested [x,y] arrays to Float32Array for compactness
        if (poly instanceof Float32Array) {
            // bbox may already be set by producers
            if (!poly.bbox) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < poly.length; i += 2) {
                    const x = poly[i];
                    const y = poly[i + 1];
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
                poly.bbox = { minX, minY, maxX, maxY };
            }
            target.push(poly);
        } else if (Array.isArray(poly) && poly.length > 0) {
            const flat = new Float32Array(poly.length * 2);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < poly.length; i++) {
                const x = poly[i][0];
                const y = poly[i][1];
                flat[i * 2] = x;
                flat[i * 2 + 1] = y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            flat.bbox = { minX, minY, maxX, maxY };
            target.push(flat);
        }

        if (target.length > MAX_PER_LAYER) {
            target.splice(0, target.length - MAX_PER_LAYER);
        }
    }
}

function pushViewportSnapPolys(layerKey, polys, opts) {
    if (!polys || polys.length === 0) return;
    const target = ensureViewportSnapLayer(layerKey);

    // Keep this cache bounded by default, but allow callers (e.g. box-select backendFinal)
    // to disable or raise the limit so large selections don't get truncated.
    const maxPerLayer = (opts && typeof opts.maxPerLayer === 'number') ? opts.maxPerLayer : 20000;

    for (const poly of polys) {
        // v2-only: viewportSnap polygons must be Float32Array and carry polyId.
        if (!(poly instanceof Float32Array)) continue;
        if (!poly.polyId) continue;

        if (!poly.bbox) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < poly.length; i += 2) {
                const x = poly[i];
                const y = poly[i + 1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            poly.bbox = { minX, minY, maxX, maxY };
        }

        target.push(poly);

        if (maxPerLayer > 0 && target.length > maxPerLayer) {
            target.splice(0, target.length - maxPerLayer);
        }
    }
}

let geometryWs = null;
let geometryWsConnected = false;
let geometryWsInfo = null;
let geometryWsReadyCallbacks = [];
const wsTextDecoder = new TextDecoder();

const profLog = (...args) => {
    if (!state.enableProfiling) return;
    console.log(...args);
};

let geometryWsProf = {
    connectedAt: null,
    authedAt: null,
    firstBinaryAt: null,
    framesSeen: 0,
    kindCounts: Object.create(null)
};

function scheduleDrawWebGL() {
    if (state.currentEngine !== 'webgl') return;
    if (!state.gl) return;
    if (state.drawWebGLPending) return;
    state.drawWebGLPending = true;
    requestAnimationFrame(() => {
        state.drawWebGLPending = false;
        drawWebGL();
    });
}

function deleteWebGLBufferList(list) {
    if (!state.gl || !list) return;
    const gl = state.gl;
    const arr = Array.isArray(list) ? list : [list];
    for (const item of arr) {
        if (item && item.buffer) {
            try { gl.deleteBuffer(item.buffer); } catch (_) { }
        }
    }
}

function deleteWebGLLayerBuffersMap(map) {
    if (!map) return;
    for (const k of Object.keys(map)) {
        deleteWebGLBufferList(map[k]);
    }
}

function deleteWebGLInstanceBuffersMap(map) {
    if (!map) return;
    for (const k of Object.keys(map)) {
        deleteWebGLBufferList(map[k]);
    }
}

function resetViewportStaging() {
    // If a previous staging snapshot exists (e.g. superseded), delete its GL buffers to avoid leaks.
    deleteWebGLLayerBuffersMap(state.viewportStagingLayerBuffers);
    deleteWebGLInstanceBuffersMap(state.viewportStagingInstanceBuffers);
    state.viewportStagingLayerBuffers = null;
    state.viewportStagingInstanceBuffers = null;
    state.viewportStagingInstanceTransforms = null;
    state.viewportReceivingRequestId = 0;
}

function beginViewportSnapshot(requestId) {
    // Do not clear current buffers here; keep rendering the previous snapshot while
    // we receive the new one (prevents black flicker during pan/zoom).
    resetViewportStaging();
    state.viewportReceivingRequestId = requestId >>> 0;
    state.viewportStagingLayerBuffers = {};
    state.viewportStagingInstanceBuffers = {};
    state.viewportStagingInstanceTransforms = {};

    // Keep snapping cache lightweight and in-sync with the currently visible snapshot.
    // We'll refill this as polygon chunks arrive.
    state.snapGeometry = {};
}

function commitViewportSnapshot(requestId) {
    const rid = requestId >>> 0;
    if (rid < (state.viewportActiveRequestId >>> 0)) {
        // Older than what we already show.
        resetViewportStaging();
        return;
    }
    if (!state.viewportStagingLayerBuffers || !state.viewportStagingInstanceBuffers) {
        // Nothing staged; keep old snapshot.
        return;
    }

    // Delete old dynamic buffers, then swap in staged buffers.
    deleteWebGLLayerBuffersMap(state.layerBuffers);
    deleteWebGLInstanceBuffersMap(state.instanceBuffers);

    state.layerBuffers = state.viewportStagingLayerBuffers;
    state.instanceBuffers = state.viewportStagingInstanceBuffers;
    state.instanceTransforms = state.viewportStagingInstanceTransforms || {};
    state.viewportActiveRequestId = rid;

    state.viewportStagingLayerBuffers = null;
    state.viewportStagingInstanceBuffers = null;
    state.viewportStagingInstanceTransforms = null;
    state.viewportReceivingRequestId = 0;
}

function onGeometryWsReady(cb) {
    if (geometryWsConnected) {
        setTimeout(cb, 0);
        return;
    }
    geometryWsReadyCallbacks.push(cb);
}

function flushGeometryWsReadyCallbacks() {
    if (!geometryWsConnected) return;
    if (!geometryWsReadyCallbacks || geometryWsReadyCallbacks.length === 0) return;
    const cbs = geometryWsReadyCallbacks;
    geometryWsReadyCallbacks = [];
    for (const cb of cbs) {
        try { setTimeout(cb, 0); } catch (_) { }
    }
}

function formatChunkProgress(chunkIndex, totalChunks) {
    const cur = (chunkIndex ?? 0) + 1;
    if (totalChunks && totalChunks > 0) return `(${cur}/${totalChunks})`;
    return `(${cur})`;
}

function maybeSignalReadyForNext(chunkIndex, totalChunks) {
    if (state.flowControlStep !== -1 && (chunkIndex % state.flowControlStep === 0 || (totalChunks > 0 && chunkIndex === totalChunks - 1))) {
        setTimeout(() => {
            state.vscode.postMessage({ command: 'ready_for_next' });
        }, 0);
    }
}

function addWebGLVerticesChunk(layerKey, type, cellName, vertices) {
    if (!vertices || vertices.length === 0 || !state.gl) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < vertices.length; i += 2) {
        const x = vertices[i];
        const y = vertices[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const bbox = { minX, minY, maxX, maxY };

    const buffer = state.gl.createBuffer();
    state.gl.bindBuffer(state.gl.ARRAY_BUFFER, buffer);
    state.gl.bufferData(state.gl.ARRAY_BUFFER, vertices, state.gl.STATIC_DRAW);

    if (type === 'definition') {
        const key = cellName || "UNKNOWN_CELL";
        if (!state.definitions[key]) state.definitions[key] = {};
        if (!state.definitions[key][layerKey]) state.definitions[key][layerKey] = [];
        state.definitions[key][layerKey].push({ buffer, count: vertices.length / 2, bbox });
    } else {
        const target = state.viewportStagingLayerBuffers || state.layerBuffers;
        if (!target[layerKey]) target[layerKey] = [];
        target[layerKey].push({ buffer, count: vertices.length / 2, bbox });
    }

    scheduleDrawWebGL();
}

function handleInstanceDataInto(cellName, buffer, instanceBuffers, instanceTransforms) {
    const dataView = new DataView(buffer);
    const count = dataView.getUint32(0, true);

    if (!state.gl) return count;

    const transforms = new Float32Array(buffer, 4, count * 9);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
        const tx = transforms[i * 9 + 6];
        const ty = transforms[i * 9 + 7];
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
    }
    const originBBox = { minX, minY, maxX, maxY };

    const key = cellName || "UNKNOWN_CELL";
    if (!instanceTransforms[key]) instanceTransforms[key] = [];
    instanceTransforms[key].push(transforms);

    const glBuffer = state.gl.createBuffer();
    state.gl.bindBuffer(state.gl.ARRAY_BUFFER, glBuffer);
    state.gl.bufferData(state.gl.ARRAY_BUFFER, transforms, state.gl.STATIC_DRAW);

    if (!instanceBuffers[key]) instanceBuffers[key] = [];
    instanceBuffers[key].push({ buffer: glBuffer, count, originBBox });

    return count;
}

function handleGeometryWsBinary(buffer) {
    const dv = new DataView(buffer);
    let off = 0;
    const version = dv.getUint8(off); off += 1;
    const kind = dv.getUint8(off); off += 1;
    const flags = dv.getUint16(off, true); off += 2;
    const chunkIndex = dv.getUint32(off, true); off += 4;
    const totalChunks = dv.getUint32(off, true); off += 4;
    const layerLen = dv.getUint16(off, true); off += 2;
    const cellLen = dv.getUint16(off, true); off += 2;

    const layerKey = wsTextDecoder.decode(new Uint8Array(buffer, off, layerLen));
    off += layerLen;
    const cellNameStr = wsTextDecoder.decode(new Uint8Array(buffer, off, cellLen));
    off += cellLen;
    const cellName = cellNameStr || null;

    const isHighlightLayer = layerKey === '__highlight__';

    const freeBufferList = (lst) => {
        if (!state.gl || !Array.isArray(lst)) return;
        for (const it of lst) {
            try {
                if (it && it.buffer) state.gl.deleteBuffer(it.buffer);
            } catch (_) { }
        }
    };

    const beginHighlightSnapshot = (seq) => {
        if (!state.gl) return;
        state.highlightReceivingSeq = (seq >>> 0);
        // Clear staging; keep active until commit.
        state.highlightStagingBuffers = [];
    };

    const commitHighlightSnapshot = (seq) => {
        if (!state.gl) return;
        if ((seq >>> 0) !== (state.highlightReceivingSeq >>> 0)) return;
        // Free old buffers to avoid leaks across many highlight updates.
        freeBufferList(state.highlightBuffers);
        state.highlightBuffers = state.highlightStagingBuffers || [];
        state.highlightStagingBuffers = null;
        state.highlightActiveSeq = (seq >>> 0);
    };

    const addWebGLHighlightVerticesChunk = (vertices) => {
        if (!state.gl || !vertices || vertices.length <= 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < vertices.length; i += 2) {
            const x = vertices[i];
            const y = vertices[i + 1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const bbox = { minX, minY, maxX, maxY };

        const glBuffer = state.gl.createBuffer();
        state.gl.bindBuffer(state.gl.ARRAY_BUFFER, glBuffer);
        state.gl.bufferData(state.gl.ARRAY_BUFFER, vertices, state.gl.STATIC_DRAW);

        const target = state.highlightStagingBuffers || state.highlightBuffers || (state.highlightBuffers = []);
        target.push({ buffer: glBuffer, count: vertices.length / 2, bbox });
        scheduleDrawWebGL();
    };

    // Fast-path drop: snap polygon streams are tagged with a token in cellName.
    // We support two concurrent snap consumers:
    // - Measure tool (viewport snapPolygons) -> state.snapGeometry (token = state.snapViewportTokenCurrent)
    // - Box select (viewportSnap) -> state.snapGeometryViewport (token = state.boxSelectPending.token)
    // If a chunk belongs to neither active token, drop it without parsing.
    if (kind === 4 && state.currentEngine === 'webgl' && cellNameStr && cellNameStr.startsWith('__snap__:')) {
        const measureToken = state.snapViewportTokenCurrent || null;
        const boxToken = (state.boxSelectPending && state.boxSelectPending.token) ? state.boxSelectPending.token : null;
        const matchesMeasure = !!measureToken && cellNameStr === measureToken;
        const matchesBox = !!boxToken && cellNameStr === boxToken;
        if ((measureToken || boxToken) && !matchesMeasure && !matchesBox) {
            return;
        }
    }

    // Payload starts at off
    if (version !== 1 && version !== 2) {
        console.warn('Unsupported WS geometry frame version:', version);
        return;
    }

    // kind:
    // 1 FlatTriangles
    // 2 DefinitionTriangles
    // 3 Instances
    // 4 FlatPolygons
    // 5 Control (viewport snapshots)
    if (kind === 5) {
        const opcode = dv.getUint8(off); off += 1;
        const requestId = dv.getUint32(off, true); off += 4;

        // Highlight snapshots: begin/end for __highlight__ overlay buffers.
        if (isHighlightLayer) {
            if (opcode === 1) {
                beginHighlightSnapshot(requestId);
                scheduleDrawWebGL();
            } else if (opcode === 2) {
                commitHighlightSnapshot(requestId);
                scheduleDrawWebGL();
            }
            return;
        }

        // Snapping-only viewport markers: do NOT touch render snapshot staging.
        // We use layerKey='__snap__' to distinguish from render viewport streaming.
        if (layerKey === '__snap__') {
            const token = cellNameStr || null;
            const measureToken = state.snapViewportTokenCurrent || null;
            const boxToken = (state.boxSelectPending && state.boxSelectPending.token) ? state.boxSelectPending.token : null;

            // Drop stale control frames from an older snap token.
            if (token && (measureToken || boxToken) && token !== measureToken && token !== boxToken) {
                return;
            }
            if (opcode === 1) {
                // cellName carries the snap token so we can drop stale polygon chunks.
                // If this begin belongs to an active box-select request, clear the viewportSnap cache;
                // otherwise treat it as the measure snapping stream and clear snapGeometry.
                if (token && boxToken && token === boxToken) {
                    if (state.boxSelectPending && state.boxSelectPending.backendFinal) {
                        state.boxSelectPending.receivedPolys = 0;
                    }
                    if (state.enableProfiling) {
                        try { console.log('[prof] boxSelect snap begin', { token }); } catch (_) { }
                    }
                    state.snapGeometryViewport = {};
                } else {
                    state.snapViewportTokenCurrent = token;
                    state.snapGeometry = {};
                }
            } else if (opcode === 2) {
                // End of snap stream. For backend-final box select, finalize immediately without costly containment checks.
                if (token && boxToken && token === boxToken && state.boxSelectPending && state.boxSelectPending.backendFinal) {
                    if (state.enableProfiling) {
                        try { console.log('[prof] boxSelect snap end', { token, receivedPolys: state.boxSelectPending?.receivedPolys ?? null }); } catch (_) { }
                    }
                    finalizeBoxSelectDirectFromSnap(token);
                }
            }
            return;
        }

        // opcode:
        // 1 BeginViewport (clear per-viewport buffers)
        // 2 EndViewport (optional)
        if (opcode === 1) {
            if (requestId >= (state.viewportActiveRequestId >>> 0)) {
                beginViewportSnapshot(requestId);
            }
            scheduleDrawWebGL();
        } else if (opcode === 2) {
            // Swap staged buffers into active buffers.
            if (requestId === (state.viewportReceivingRequestId >>> 0)) {
                commitViewportSnapshot(requestId);
            }
            scheduleDrawWebGL();
        }
        return;
    }
    if (kind === 3) {
        const payload = buffer.slice(off);
        const targetBuffers = state.viewportStagingInstanceBuffers || state.instanceBuffers;
        const targetTransforms = state.viewportStagingInstanceTransforms || state.instanceTransforms;
        const count = handleInstanceDataInto(cellName, payload, targetBuffers, targetTransforms);
        updateStatus(`Loading Instances ${cellName || 'Unknown'} ${formatChunkProgress(chunkIndex, totalChunks)} - ${count} items`);
        maybeSignalReadyForNext(chunkIndex, totalChunks);
        scheduleDrawWebGL();
        return;
    }

    if (kind === 1 || kind === 2) {
        const vertexCount = dv.getUint32(off, true);
        const floatsByteLen = vertexCount * 2 * 4;
        const start = off + 4;
        const end = start + floatsByteLen;
        if (end > buffer.byteLength) {
            console.warn('WS geometry frame truncated (triangles):', { layerKey, cellName, chunkIndex, totalChunks, vertexCount, byteLength: buffer.byteLength, start, end });
            return;
        }

        // The float payload is not guaranteed to be 4-byte aligned because the header includes
        // variable-length UTF-8 strings. Slice into a new ArrayBuffer to guarantee alignment.
        const vertices = new Float32Array(buffer.slice(start, end));

        // Highlight overlay triangles
        if (isHighlightLayer) {
            addWebGLHighlightVerticesChunk(vertices);
            return;
        }

        addWebGLVerticesChunk(layerKey, kind === 2 ? 'definition' : 'flat', cellName, vertices);
        updateStatus(`Loading ${layerKey || 'Unknown'}${cellName ? ' ' + cellName : ''} ${formatChunkProgress(chunkIndex, totalChunks)}`);
        maybeSignalReadyForNext(chunkIndex, totalChunks);
        return;
    }

    if (kind === 4) {
        // Polygons payload:
        // - v1: u32 polyCount, then per poly: u32 nPoints, then nPoints * (f32 x, f32 y)
        // - v2 (snap-only): u32 polyCount, then per poly:
        //     u32 instance_id, u32 poly_index, u32 nPoints, then nPoints * (f32 x, f32 y)
        const polyCount = dv.getUint32(off, true);
        off += 4;
        const polys = [];
        for (let p = 0; p < polyCount; p++) {
            let instanceId = null;
            let polyIndex = null;
            if (version === 2) {
                instanceId = dv.getUint32(off, true); off += 4;
                polyIndex = dv.getUint32(off, true); off += 4;
            }

            const nPoints = dv.getUint32(off, true);
            off += 4;
            const flat = new Float32Array(nPoints * 2);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < nPoints; i++) {
                const x = dv.getFloat32(off, true); off += 4;
                const y = dv.getFloat32(off, true); off += 4;
                flat[i * 2] = x;
                flat[i * 2 + 1] = y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            flat.bbox = { minX, minY, maxX, maxY };

            if (version === 2 && instanceId !== null && polyIndex !== null) {
                // polyId is a stable identifier for merge/toggle operations.
                flat.polyId = [instanceId, polyIndex];
            }
            polys.push(flat);
        }

        if (state.currentEngine === 'canvas') {
            if (polys.length > 0) {
                if (!state.geometry[layerKey]) state.geometry[layerKey] = [];
                state.geometry[layerKey].push(...polys);
                requestAnimationFrame(draw);
            }
        }

        // WebGL: keep a lightweight polygon cache for snapping.
        if (state.currentEngine === 'webgl') {
            // Snap polygon streams are tagged with a token like '__snap__:N'.
            if (cellNameStr && cellNameStr.startsWith('__snap__:')) {
                const isBoxSelect = !!(state.boxSelectPending && state.boxSelectPending.token === cellNameStr);
                const isMeasure = !!(state.snapViewportTokenCurrent && state.snapViewportTokenCurrent === cellNameStr);

                // Box select (viewportSnap) must be v2 so polyId is available for stable merge/toggle.
                if (isBoxSelect) {
                    if (version !== 2) return;
                    const isBackendFinal = !!(state.boxSelectPending && state.boxSelectPending.backendFinal);
                    // backendFinal expects to potentially select >20k polys on a single layer.
                    // Do not truncate the cache for the active box-select token.
                    pushViewportSnapPolys(layerKey, polys, isBackendFinal ? { maxPerLayer: 0 } : undefined);
                    if (state.boxSelectPending && state.boxSelectPending.backendFinal) {
                        state.boxSelectPending.receivedPolys = (state.boxSelectPending.receivedPolys || 0) + polys.length;
                    }
                    if (!(state.boxSelectPending && state.boxSelectPending.backendFinal)) {
                        maybeFinalizeBoxSelectFromSnap(cellNameStr);
                    }
                    // Avoid spamming status for snap-only background streams.
                    return;
                }

                // Measure snapping stream: populate state.snapGeometry so edge/vertex snapping works.
                // This stream may be v1 or v2; the parser above already handled both.
                if (isMeasure) {
                    pushSnapPolys(layerKey, polys);
                    // Avoid spamming status for background snap streams.
                    return;
                }

                // If we can't attribute this token to an active consumer, drop it.
                return;
            }

            pushSnapPolys(layerKey, polys);
        }

        updateStatus(`Loading ${layerKey || 'Unknown'}${cellName ? ' ' + cellName : ''} ${formatChunkProgress(chunkIndex, totalChunks)}`);
        maybeSignalReadyForNext(chunkIndex, totalChunks);
        return;
    }

    console.warn('Unknown WS geometry frame kind:', kind);
}

function isWebglRust() {
    return state.currentEngine === 'webgl' && state.config && state.config.engineType === 'rust';
}

function collectHighlightPolyIds(items) {
    const out = [];
    if (!Array.isArray(items)) return out;
    for (const it of items) {
        const pid = it && it.polyId;
        if (!Array.isArray(pid) || pid.length !== 2) continue;
        const a = pid[0];
        const b = pid[1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        out.push([a >>> 0, b >>> 0]);
    }
    return out;
}

function postHighlightUpdate(reason) {
    if (!isWebglRust()) return;
    if (!state.vscode || !state.vscode.postMessage) return;

    const polyIds = collectHighlightPolyIds(state.highlightedPolygons);
    const clientSeq = (state.highlightClientSeq + 1) >>> 0;
    state.highlightClientSeq = clientSeq;

    state.vscode.postMessage({
        command: 'highlightUpdate',
        clientSeq,
        polyIds,
        reason: reason || null,
    });
}

function connectGeometryWebSocket(wsInfo) {
    if (!wsInfo || !wsInfo.token) return;

    const url = wsInfo.url ? String(wsInfo.url) : (wsInfo.port ? `ws://127.0.0.1:${wsInfo.port}` : null);
    if (!url) return;

    updateStatus(`Connecting geometry WS${wsInfo.url ? ' (remote)' : ''}...`);

    // If we are already connected to a different wsInfo, reconnect.
    if (geometryWsConnected && geometryWsInfo && (geometryWsInfo.url !== url || geometryWsInfo.token !== wsInfo.token)) {
        try { geometryWs.close(); } catch (_) { }
        geometryWsConnected = false;
    }
    if (geometryWsConnected) return;

    geometryWsInfo = { url, token: wsInfo.token };

    geometryWsProf = {
        connectedAt: null,
        authedAt: null,
        firstBinaryAt: null,
        framesSeen: 0,
        kindCounts: Object.create(null)
    };

    geometryWs = new WebSocket(url);
    geometryWs.binaryType = 'arraybuffer';

    geometryWs.onopen = () => {
        geometryWsConnected = true;
        geometryWsProf.connectedAt = performance.now();
        profLog(`[prof] geometry WS open: ${url}`);

        geometryWs.send(wsInfo.token);
        geometryWsProf.authedAt = performance.now();
        flushGeometryWsReadyCallbacks();
    };
    geometryWs.onmessage = (ev) => {
        if (typeof ev.data === 'string') return;

        if (!geometryWsProf.firstBinaryAt) {
            geometryWsProf.firstBinaryAt = performance.now();
            const bytes = ev.data instanceof ArrayBuffer ? ev.data.byteLength : (ev.data?.byteLength ?? 0);
            let version = null;
            let kind = null;
            try {
                if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 2) {
                    const u8 = new Uint8Array(ev.data, 0, 2);
                    version = u8[0];
                    kind = u8[1];
                }
            } catch (_) { }
            profLog(`[prof] geometry WS first binary: version=${version} kind=${kind} bytes=${bytes}`);
        }

        try {
            if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 2) {
                const kind = new Uint8Array(ev.data, 1, 1)[0];
                geometryWsProf.framesSeen += 1;
                geometryWsProf.kindCounts[kind] = (geometryWsProf.kindCounts[kind] || 0) + 1;
                if (geometryWsProf.framesSeen === 100) {
                    profLog(`[prof] geometry WS first 100 frames kindCounts=${JSON.stringify(geometryWsProf.kindCounts)}`);
                }
            }
        } catch (_) { }

        state.pendingTasks++;
        try {
            handleGeometryWsBinary(ev.data);
        } finally {
            state.pendingTasks--;
            checkCompletion();
        }
    };
    geometryWs.onerror = (e) => {
        console.error('Geometry WebSocket error', e);
        updateStatus('Geometry WebSocket error');
    };
    geometryWs.onclose = () => {
        geometryWsConnected = false;
        profLog(`[prof] geometry WS closed (framesSeen=${geometryWsProf.framesSeen})`);
    };
}

export function handleSearchWorkerMessage(e) {
    const msg = e.data;
    if (msg.command === 'status') {
        updateStatus(msg.message);
    } else if (msg.command === 'found' || msg.command === 'picked') {
        const toNested = (poly) => {
            if (!poly) return null;
            if (poly instanceof Float32Array) {
                const pts = [];
                for (let i = 0; i < poly.length; i += 2) pts.push([poly[i], poly[i + 1]]);
                return pts;
            }
            if (Array.isArray(poly)) return poly;
            return null;
        };

        let items = [];
        if (Array.isArray(msg.polygonsV2)) {
            items = msg.polygonsV2
                .map((it) => {
                    if (!it) return null;
                    const pts = toNested(it.points);
                    if (!pts) return null;
                    return {
                        layerKey: (typeof it.layerKey === 'string' && it.layerKey.length > 0) ? it.layerKey : null,
                        points: pts,
                        polyId: (Array.isArray(it.polyId) && it.polyId.length === 2) ? it.polyId : null,
                    };
                })
                .filter(Boolean);
        } else {
            // v2-only: highlight pipeline expects polygonsV2.
            return;
        }

        const normCoord = (v) => {
            // Normalize float32/f64 noise so keys match across:
            // - viewportSnap (Float32) polygons
            // - pick/find (f64) polygons
            if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
            return Math.round(v * 1e6) / 1e6;
        };

        const polyItemKey = (it) => {
            if (!it) return '';
            if (Array.isArray(it.polyId) && it.polyId.length === 2) {
                return `id:${it.polyId[0]},${it.polyId[1]}`;
            }
            if (!Array.isArray(it.points)) return '';
            const lk = typeof it.layerKey === 'string' ? it.layerKey : '';
            // Note: points are already nested [x,y]. Use normalized coords for stable matching.
            return lk + ':' + it.points.map(p => `${normCoord(p[0])},${normCoord(p[1])}`).join(';');
        };
        const mergeItems = (existing, incoming) => {
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

        const toggleItems = (existing, incoming) => {
            const existingArr = Array.isArray(existing) ? existing : [];
            const incomingArr = Array.isArray(incoming) ? incoming : [];

            const removeKeys = new Set();
            const addList = [];

            const existingKeys = new Set(existingArr.map(polyItemKey).filter(Boolean));

            for (const it of incomingArr) {
                if (!it || !Array.isArray(it.points) || it.points.length < 3) continue;
                const k = polyItemKey(it);
                if (!k) continue;
                if (existingKeys.has(k)) {
                    removeKeys.add(k);
                } else {
                    addList.push(it);
                }
            }

            const kept = existingArr.filter(it => {
                const k = polyItemKey(it);
                return !k || !removeKeys.has(k);
            });

            return mergeItems(kept, addList);
        };

        const additive = !!state.mergeNextHighlight;
        state.mergeNextHighlight = false;

        // Modifier behavior:
        // - for 'found' (double-click net tracing): Shift union-merge
        // - for 'picked' (right-click pick): Shift toggle (remove if already highlighted, else add)
        if (additive) {
            state.highlightedPolygons = (msg.command === 'picked')
                ? toggleItems(state.highlightedPolygons, items)
                : mergeItems(state.highlightedPolygons, items);
        } else {
            state.highlightedPolygons = items;
        }

        // WebGL+Rust: backend owns highlight rendering; we only keep polygons for copy/measure.
        // Send polyId set to backend so it can stream __highlight__ triangles.
        postHighlightUpdate(msg.command);

        // Create Path2D for efficient rendering
        if (!isWebglRust()) {
            const LARGE_HIGHLIGHT_THRESHOLD = 5000;
            if (state.highlightedPolygons.length > LARGE_HIGHLIGHT_THRESHOLD) {
                scheduleHighlightedPathBuild(state.highlightedPolygons, msg.command);
            } else {
                cancelHighlightedPathBuild();
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
                state.highlightedPath = path;
            }
        } else {
            // Ensure any in-progress Path2D build is cancelled to avoid wasted main-thread work.
            cancelHighlightedPathBuild();
            state.highlightedPath = null;
        }

        const timeStr = msg.duration ? ` in ${msg.duration}ms` : '';
        if (msg.command === 'picked') {
            if (state.highlightedPolygons.length === 0) {
                updateStatus(`No polygon found at clicked location${timeStr}`);
            } else {
                updateStatus(`Highlighted ${state.highlightedPolygons.length} polygon(s)${timeStr}`);
            }
        } else if (msg.limitReached) {
            updateStatus(`Highlighted ${state.highlightedPolygons.length} objects (Search limit reached)${timeStr}`);
        } else if (state.highlightedPolygons.length === 0) {
            updateStatus(`No object found at clicked location${timeStr}`);
        } else {
            updateStatus(`Highlighted ${state.highlightedPolygons.length} connected objects${timeStr}`);
        }
        requestAnimationFrame(drawLabels);
    }
}

export function handleWorkerMessage(e, workerIndex) {
    if (e.data.type === 'log') {
        return;
    }
    if (e.data.type === 'error') {
        console.error(`Worker ${workerIndex} Error:`, e.data.error);
        updateStatus(`Worker ${workerIndex} error: ${e.data.error}`);
        return;
    }

    const { id, vertices, polygons, duration } = e.data;
    if (duration) state.perfMetrics.workerTime += duration;

    const layerKey = id.layerKey;
    const type = id.type;
    const cellName = id.cellName || "UNKNOWN_CELL";

    if (polygons) {
        // Always calculate bbox for polygons as it might be needed for definitionBBoxes or if we store them
        for (const poly of polygons) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < poly.length; i += 2) {
                const x = poly[i];
                const y = poly[i + 1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            poly.bbox = { minX, minY, maxX, maxY };
        }

        if (type === 'definition') {
            // Always update definitionBBoxes as it is used for culling in WebGL
            if (!state.definitionBBoxes[cellName]) state.definitionBBoxes[cellName] = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            const db = state.definitionBBoxes[cellName];
            for (const poly of polygons) {
                if (poly.bbox.minX < db.minX) db.minX = poly.bbox.minX;
                if (poly.bbox.minY < db.minY) db.minY = poly.bbox.minY;
                if (poly.bbox.maxX > db.maxX) db.maxX = poly.bbox.maxX;
                if (poly.bbox.maxY > db.maxY) db.maxY = poly.bbox.maxY;
            }

            // Optimization: Only store geometry if NOT in WebGL mode (to save RAM)
            if (state.currentEngine !== 'webgl') {
                if (!state.definitionGeometry[cellName]) state.definitionGeometry[cellName] = {};
                if (!state.definitionGeometry[cellName][layerKey]) state.definitionGeometry[cellName][layerKey] = [];
                state.definitionGeometry[cellName][layerKey].push(...polygons);
            }
        } else {
            // Optimization: Only store geometry if NOT in WebGL mode
            if (state.currentEngine !== 'webgl') {
                if (!state.geometry[layerKey]) state.geometry[layerKey] = [];
                state.geometry[layerKey].push(...polygons);
            }
        }

        if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
    }

    if (vertices && vertices.length > 0 && state.gl) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < vertices.length; i += 2) {
            const x = vertices[i];
            const y = vertices[i + 1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const bbox = { minX, minY, maxX, maxY };

        const buffer = state.gl.createBuffer();
        state.gl.bindBuffer(state.gl.ARRAY_BUFFER, buffer);
        state.gl.bufferData(state.gl.ARRAY_BUFFER, vertices, state.gl.STATIC_DRAW);

        if (type === 'definition') {
            if (!state.definitions[cellName]) state.definitions[cellName] = {};
            if (!state.definitions[cellName][layerKey]) state.definitions[cellName][layerKey] = [];

            state.definitions[cellName][layerKey].push({
                buffer: buffer,
                count: vertices.length / 2,
                bbox: bbox
            });
        } else {
            if (!state.layerBuffers[layerKey]) state.layerBuffers[layerKey] = [];

            state.layerBuffers[layerKey].push({
                buffer: buffer,
                count: vertices.length / 2,
                bbox: bbox
            });
        }

        requestAnimationFrame(drawWebGL);
    }

    if (id.alsoTriangulate && polygons && !vertices) {
        return;
    }

    state.pendingTasks--;
    checkCompletion();
}

export function handleInstanceData(cellName, buffer) {
    const targetBuffers = state.viewportStagingInstanceBuffers || state.instanceBuffers;
    const targetTransforms = state.viewportStagingInstanceTransforms || state.instanceTransforms;
    const count = handleInstanceDataInto(cellName, buffer, targetBuffers, targetTransforms);
    scheduleDrawWebGL();
    return count;
}

export function handleAddLayerChunkB64(layerKey, chunkIndex, totalChunks, b64Data, type, cellName) {
    state.pendingTasks++;

    const binaryString = window.atob(b64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const buffer = bytes.buffer;

    if (type === 'instance') {
        const count = handleInstanceData(cellName, buffer);
        state.pendingTasks--;

        if (state.flowControlStep !== -1 && (chunkIndex % state.flowControlStep === 0 || chunkIndex === totalChunks - 1)) {
            setTimeout(() => {
                state.vscode.postMessage({ command: 'ready_for_next' });
            }, 0);
        }
        updateStatus(`Loading Instances ${cellName || 'Unknown'} (${chunkIndex + 1}/${totalChunks || '?'}) - ${count} items`);
        return;
    }

    const worker = state.workerPool[state.workerRoundRobin];
    state.workerRoundRobin = (state.workerRoundRobin + 1) % state.workerPool.length;

    worker.postMessage({
        id: { layerKey, chunkIndex, type, cellName, alsoTriangulate: state.currentEngine === 'webgl' },
        buffer: buffer,
        isBinary: true,
        returnPolygons: true,
        alsoTriangulate: state.currentEngine === 'webgl'
    }, [buffer]);

    if (state.flowControlStep !== -1 && (chunkIndex % state.flowControlStep === 0 || chunkIndex === totalChunks - 1)) {
        setTimeout(() => {
            state.vscode.postMessage({ command: 'ready_for_next' });
        }, 0);
    }
    updateStatus(`Loading ${layerKey || 'Unknown'}${cellName ? ' ' + cellName : ''} (${chunkIndex + 1}/${totalChunks || '?'})`);
}

export function handleAddLayerChunk(layerKey, data) {
    const polys = data.polygons;

    // Optimization: In WebGL mode, we don't store raw polygons in main thread to save memory
    if (state.currentEngine === 'canvas') {
        if (polys && polys.length > 0) {
            if (!state.geometry[layerKey]) state.geometry[layerKey] = [];

            for (const poly of polys) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of poly) {
                    if (p[0] < minX) minX = p[0];
                    if (p[0] > maxX) maxX = p[0];
                    if (p[1] < minY) minY = p[1];
                    if (p[1] > maxY) maxY = p[1];
                }
                poly.bbox = { minX, minY, maxX, maxY };
            }
            state.geometry[layerKey].push(...polys);
        }
    }

    // WebGL: keep a lightweight polygon cache for snapping.
    if (state.currentEngine === 'webgl') {
        pushSnapPolys(layerKey, polys);
    }

    if (data.labels && data.labels.length > 0) {
        if (!state.labels[layerKey]) state.labels[layerKey] = [];
        state.labels[layerKey].push(...data.labels);
    }

    if (state.currentEngine === 'webgl' && polys && polys.length > 0) {
        const worker = state.workerPool[state.workerRoundRobin];
        state.workerRoundRobin = (state.workerRoundRobin + 1) % state.workerPool.length;

        worker.postMessage({
            id: { layerKey, chunkIndex: data.chunkIndex },
            polygons: polys
        });
    }

    if (data.chunkIndex !== undefined) {
        updateStatus(`Loading ${layerKey} (${data.chunkIndex + 1}/${data.totalChunks || '?'})`);
    } else {
        updateStatus(`Loading ${layerKey} (Labels)`);
    }

    if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
    requestAnimationFrame(drawLabels);
}

export function handleInitialize(data) {
    state.startTime = performance.now();
    state.pendingTasks = 0;
    state.pythonFinished = false;
    state.completionShown = false;
    state.completionScheduled = false;
    state.statusPinUntil = 0;
    state.isViewFitted = false;
    state.hasUserInteracted = false;
    updateStatus("Initializing...");

    state.geometry = {};
    state.snapGeometry = {};
    state.snapViewportSeq = 0;
    state.snapViewportTokenCurrent = null;
    state.labels = {};
    state.highlightedPolygons = [];
    cancelHighlightedPathBuild();
    state.highlightedPath = null;
    state.bbox = data.bbox;
    if (data.ports) {
        state.ports = data.ports;
        console.log(`[Webview] Received ${state.ports.length} ports in initialize`);
    } else {
        state.ports = [];
    }
    state.activeLayers.clear();
    state.hasUserInteracted = false;
    state.layerColors = {};
    state.layerOpacities = {};
    state.layerBuffers = {};

    buildTree(data.hierarchy, data.top_level_cells, data.all_cells, data.cell_name);

    state.allLayers = data.layers;

    if (!elements.layersList) return;
    elements.layersList.innerHTML = '';
    state.allLayers.forEach(layerKey => {
        state.activeLayers.add(layerKey);

        let color = "#888888";
        const parts = layerKey.split('_');
        if (parts.length >= 1) {
            const layerNum = parseInt(parts[0]);
            if (!isNaN(layerNum)) {
                color = state.palette[layerNum % state.palette.length];
            } else {
                let hash = 0;
                for (let i = 0; i < layerKey.length; i++) {
                    hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                }
                color = state.palette[Math.abs(hash) % state.palette.length];
            }
        }
        state.layerColors[layerKey] = color;
        state.layerOpacities[layerKey] = 0.8;

        const div = document.createElement('div');
        div.className = 'layer-toggle';
        div.setAttribute('draggable', 'true');
        div.addEventListener('dragstart', handleDragStart, false);
        div.addEventListener('dragend', handleDragEnd, false);
        div.addEventListener('dragenter', handleDragEnter, false);
        div.addEventListener('dragover', handleDragOver, false);
        div.addEventListener('dragleave', handleDragLeave, false);
        div.addEventListener('drop', handleDrop, false);

        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            state.activeLayers.clear();
            state.activeLayers.add(layerKey);

            const checkboxes = document.querySelectorAll('#layers-list input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = (cb.getAttribute('data-layer-id') === layerKey);
            });

            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);

            if (state.currentEngine === 'svg') {
                state.allLayers.forEach(key => {
                    const el = document.getElementById('layer-group-' + key);
                    if (el) el.style.display = (key === layerKey) ? 'block' : 'none';
                });
            }
        });

        div.innerHTML = `
            <input type="checkbox" id="toggle-${layerKey}" data-layer-id="${layerKey}" checked>
            <label for="toggle-${layerKey}">Layer ${layerKey.replace('_', ' / ')}</label>
            <input type="color" id="color-${layerKey}" data-layer-id="${layerKey}" value="${color}">
            <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
        `;

        div.querySelectorAll('input').forEach(input => {
            input.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                div.setAttribute('draggable', 'false');
            });
            input.addEventListener('mouseup', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('mouseleave', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        elements.layersList.appendChild(div);
    });

    const dummy = document.createElement('div');
    dummy.className = 'layer-drop-dummy';
    dummy.addEventListener('dragenter', handleDragEnter, false);
    dummy.addEventListener('dragover', handleDragOver, false);
    dummy.addEventListener('dragleave', handleDragLeave, false);
    dummy.addEventListener('drop', handleDrop, false);
    elements.layersList.appendChild(dummy);

    if (state.currentEngine === 'canvas') {
        elements.canvas.style.display = 'block';
        document.getElementById('gds-webgl-canvas').style.display = 'none';
        elements.svgContainer.style.display = 'none';
        elements.svgContainer.innerHTML = '';
        resizeCanvas();
        fitView();
    } else if (state.currentEngine === 'webgl') {
        state.definitions = {};
        state.instanceBuffers = {};
        state.definitionGeometry = {};
        state.instanceTransforms = {};
        state.definitionBBoxes = {};
        setupWebGLMode({ geometry: {}, bbox: data.bbox, layers: [] });
    } else if (state.currentEngine === 'svg') {
        if (data.svg_fragments) {
            state.svgFragments = data.svg_fragments;
        }
        setupSvgMode(data);
        updateTransform();

        if (data.labels && data.labels.length > 0) {
            data.labels.forEach(l => {
                if (!state.labels[l.layerKey]) state.labels[l.layerKey] = [];
                state.labels[l.layerKey].push(l);
            });
            requestAnimationFrame(drawLabels);
        }
    }

    // If Rust provides a WebSocket endpoint for binary geometry, connect now.
    // (This replaces CHUNK_B64 base64 chunks and front-end earcut triangulation.)
    if (data.ws) {
        connectGeometryWebSocket(data.ws);
    }

    updateStatus("Loading layers...");

    // Kick an initial viewport request as soon as we have bbox + transform.
    // Listener code will also refresh on user interaction.
    if (state.currentEngine === 'webgl' && state.config.engineType === 'rust' && state.viewportStreaming && state.useInstancing) {
        let sent = false;
        const sendViewport = () => {
            if (sent) return;

            const container = elements.viewContainer;
            if (!container) return;
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (!w || !h) return;

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

            if (![minX, maxX, minY, maxY].every(Number.isFinite)) return;

            const requestId = (state.viewportRequestSeq + 1) >>> 0;
            state.viewportRequestSeq = requestId;
            sent = true;
            if (state.enableProfiling) {
                console.log('[prof] send initial viewport', { requestId, bbox: { minX, maxX, minY, maxY }, layers: state.activeLayers.size });
            }
            state.vscode.postMessage({ command: 'viewport', requestId, bbox: { minX, maxX, minY, maxY }, layers: Array.from(state.activeLayers) });
        };

        // In desktop mode, the first viewport snapshot can be produced before the WS is open/auth'd,
        // causing the initial view to appear blank until the next interaction.
        // Wait for WS open when available, but keep a timeout fallback.
        onGeometryWsReady(sendViewport);
        setTimeout(sendViewport, 500);
    }
}

export function handleDataUpdate(data) {
    updateStatus("Rendering...");

    state.completionShown = false;
    state.completionScheduled = false;
    state.statusPinUntil = 0;

    state.highlightedPolygons = [];
    cancelHighlightedPathBuild();
    state.highlightedPath = null;
    state.searchWorker.postMessage({ command: 'clear' });

    buildTree(data.hierarchy, data.top_level_cells, data.all_cells, data.cell_name);

    elements.layersList.innerHTML = '';
    state.activeLayers.clear();
    state.layerColors = {};
    state.layerOpacities = {};

    state.allLayers = data.layers;
    if (data.svg_fragments) {
        state.svgFragments = data.svg_fragments;
    } else {
        state.svgFragments = {};
    }

    state.allLayers.forEach(layerKey => {
        state.activeLayers.add(layerKey);

        let color = "#888888";
        const parts = layerKey.split('_');
        if (parts.length >= 1) {
            const layerNum = parseInt(parts[0]);
            if (!isNaN(layerNum)) {
                color = state.palette[layerNum % state.palette.length];
            } else {
                let hash = 0;
                for (let i = 0; i < layerKey.length; i++) {
                    hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                }
                color = state.palette[Math.abs(hash) % state.palette.length];
            }
        }
        state.layerColors[layerKey] = color;
        state.layerOpacities[layerKey] = 0.8;

        const div = document.createElement('div');
        div.className = 'layer-toggle';
        div.setAttribute('draggable', 'true');
        div.addEventListener('dragstart', handleDragStart, false);
        div.addEventListener('dragend', handleDragEnd, false);
        div.addEventListener('dragenter', handleDragEnter, false);
        div.addEventListener('dragover', handleDragOver, false);
        div.addEventListener('dragleave', handleDragLeave, false);
        div.addEventListener('drop', handleDrop, false);

        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            state.activeLayers.clear();
            state.activeLayers.add(layerKey);

            const checkboxes = document.querySelectorAll('#layers-list input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = (cb.getAttribute('data-layer-id') === layerKey);
            });

            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);

            if (state.currentEngine === 'svg') {
                state.allLayers.forEach(key => {
                    const el = document.getElementById('layer-group-' + key);
                    if (el) el.style.display = (key === layerKey) ? 'block' : 'none';
                });
            }
        });

        div.innerHTML = `
            <input type="checkbox" id="toggle-${layerKey}" data-layer-id="${layerKey}" checked>
            <label for="toggle-${layerKey}">Layer ${layerKey.replace('_', ' / ')}</label>
            <input type="color" id="color-${layerKey}" data-layer-id="${layerKey}" value="${color}">
            <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
        `;

        div.querySelectorAll('input').forEach(input => {
            input.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                div.setAttribute('draggable', 'false');
            });
            input.addEventListener('mouseup', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('mouseleave', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        elements.layersList.appendChild(div);
    });

    const dummy = document.createElement('div');
    dummy.className = 'layer-drop-dummy';
    dummy.addEventListener('dragenter', handleDragEnter, false);
    dummy.addEventListener('dragover', handleDragOver, false);
    dummy.addEventListener('dragleave', handleDragLeave, false);
    dummy.addEventListener('drop', handleDrop, false);
    elements.layersList.appendChild(dummy);

    if (state.currentEngine === 'canvas') {
        setupCanvasMode(data);
    } else if (state.currentEngine === 'webgl') {
        setupWebGLMode(data);
    } else {
        setupSvgMode(data);
        updateTransform();
    }

    if (!state.completionShown && !state.completionScheduled) {
        updateStatus("Ready");
    }
}

export function selectCell(cellName) {
    state.vscode.postMessage({
        command: 'changeCell',
        cellName: cellName
    });
}

export function buildTree(hierarchy, topLevelCells, allCells, currentCellName) {
    if (!elements.cellTree) return;
    elements.cellTree.innerHTML = '';

    if (!hierarchy || !topLevelCells || topLevelCells.length === 0) {
        allCells.forEach(cell => {
            const item = document.createElement('div');
            item.className = 'tree-content';
            item.style.paddingLeft = '5px';
            if (cell === currentCellName && item.classList) item.classList.add('selected');
            item.textContent = cell;
            item.onclick = () => selectCell(cell);
            elements.cellTree.appendChild(item);
        });
        return;
    }

    const validCellSet = new Set(allCells);
    let effectiveRoots = [];
    const processRoots = (roots) => {
        roots.forEach(root => {
            if (root.startsWith('$$$') || root.startsWith('TEXT')) {
                const children = hierarchy[root] || [];
                processRoots(children);
            } else {
                if (validCellSet.has(root)) {
                    effectiveRoots.push(root);
                }
            }
        });
    };
    processRoots(topLevelCells);
    effectiveRoots = [...new Set(effectiveRoots)].sort();

    function createNode(cellName, visited) {
        const item = document.createElement('div');
        item.className = 'tree-item';

        if (state.expandedNodes.has(cellName) && item && item.classList) {
            item.classList.add('expanded');
        }

        const content = document.createElement('div');
        content.className = 'tree-content';
        if (cellName === currentCellName && content && content.classList) content.classList.add('selected');

        const children = hierarchy[cellName] || [];
        const validChildren = children.filter(c => validCellSet.has(c));
        const hasChildren = validChildren.length > 0;

        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle' + (hasChildren ? '' : ' empty');
        content.appendChild(toggle);

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = cellName;
        content.appendChild(label);

        label.onclick = (e) => {
            e.stopPropagation();
            selectCell(cellName);
        };

        if (hasChildren) {
            toggle.onclick = (e) => {
                e.stopPropagation();
                item.classList.toggle('expanded');
                if (item.classList.contains('expanded')) {
                    state.expandedNodes.add(cellName);
                } else {
                    state.expandedNodes.delete(cellName);
                }
            };
        }

        item.appendChild(content);

        if (hasChildren) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';

            if (!visited.has(cellName)) {
                const newVisited = new Set(visited);
                newVisited.add(cellName);
                validChildren.forEach(childName => {
                    childrenContainer.appendChild(createNode(childName, newVisited));
                });
            } else {
                const recursiveMsg = document.createElement('div');
                recursiveMsg.textContent = '<recursive>';
                recursiveMsg.style.paddingLeft = '20px';
                recursiveMsg.style.color = '#888';
                childrenContainer.appendChild(recursiveMsg);
            }
            item.appendChild(childrenContainer);
        }

        return item;
    }

    effectiveRoots.forEach(cellName => {
        elements.cellTree.appendChild(createNode(cellName, new Set()));
    });
}

let dragSrcEl = null;

export function handleDragStart(e) {
    if (e.target.tagName === 'INPUT') {
        e.preventDefault();
        return;
    }

    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.getAttribute('data-layer-id'));
    this.classList.add('dragging');
}

export function handleDragEnd(e) {
    if (this && this.classList) this.classList.remove('dragging');
    const list = document.getElementById('layers-list');
    if (list) {
        list.querySelectorAll('.drag-over').forEach(el => {
            if (el && el.classList) el.classList.remove('drag-over');
        });
    }
}

export function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    this.classList.add('drag-over');
    return false;
}

export function handleDragEnter(e) {
    this.classList.add('drag-over');
}

export function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

export function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    if (this && this.classList) this.classList.remove('drag-over');

    if (dragSrcEl !== this) {
        const list = document.getElementById('layers-list');
        list.insertBefore(dragSrcEl, this);

        const newOrder = [];
        list.querySelectorAll('.layer-toggle').forEach(el => {
            const input = el.querySelector('input[type="checkbox"]');
            if (input) {
                newOrder.push(input.getAttribute('data-layer-id'));
            }
        });
        state.allLayers = newOrder;

        if (state.currentEngine === 'canvas') draw();
        else if (state.currentEngine === 'webgl') drawWebGL();
        else if (state.currentEngine === 'svg') {
            const group = document.getElementById('gds-user-transform-group');
            if (group) {
                const renderOrder = [...state.allLayers].reverse();
                renderOrder.forEach(layerKey => {
                    const layerGroup = document.getElementById('layer-group-' + layerKey);
                    if (layerGroup) {
                        group.appendChild(layerGroup);
                    }
                });
            }
        }
        requestAnimationFrame(drawLabels);
    }
    return false;
}
