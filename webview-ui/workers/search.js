let geometry = {};
let definitionGeometry = {};
let instanceTransforms = {};
let definitionBBoxes = {};
let activeLayers = new Set();
let isSearching = false;
let searchState = null;
let maxSteps = 5000;

self.onmessage = function (e) {
    const msg = e.data;
    switch (msg.command) {
        case 'addGeometry':
            handleAddGeometry(msg);
            break;
        case 'addInstances':
            handleAddInstances(msg);
            break;
        case 'updateActiveLayers':
            activeLayers = new Set(msg.layers);
            // console.log("Worker: Active layers updated", activeLayers.size);
            break;
        case 'updateConfig':
            if (msg.maxSteps !== undefined) maxSteps = msg.maxSteps;
            break;
        case 'find':
            startSearch(msg.x, msg.y);
            break;
        case 'stop':
            isSearching = false;
            searchState = null;
            self.postMessage({ command: 'status', message: "Search stopped by user" });
            break;
        case 'clear':
            geometry = {};
            definitionGeometry = {};
            instanceTransforms = {};
            definitionBBoxes = {};
            activeLayers.clear();
            isSearching = false;
            searchState = null;
            break;
    }
};

function handleAddGeometry(msg) {
    const { layerKey, polygons, type, cellName } = msg;
    // Calculate bboxes
    for (const poly of polygons) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const isFlat = poly instanceof Float32Array;
        const len = isFlat ? poly.length / 2 : poly.length;

        for (let i = 0; i < len; i++) {
            const x = isFlat ? poly[i * 2] : poly[i][0];
            const y = isFlat ? poly[i * 2 + 1] : poly[i][1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        poly.bbox = { minX, minY, maxX, maxY };
    }

    if (type === 'definition') {
        if (!definitionGeometry[cellName]) definitionGeometry[cellName] = {};
        if (!definitionGeometry[cellName][layerKey]) definitionGeometry[cellName][layerKey] = [];
        definitionGeometry[cellName][layerKey].push(...polygons);

        if (!definitionBBoxes[cellName]) definitionBBoxes[cellName] = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        const db = definitionBBoxes[cellName];
        for (const poly of polygons) {
            if (poly.bbox.minX < db.minX) db.minX = poly.bbox.minX;
            if (poly.bbox.minY < db.minY) db.minY = poly.bbox.minY;
            if (poly.bbox.maxX > db.maxX) db.maxX = poly.bbox.maxX;
            if (poly.bbox.maxY > db.maxY) db.maxY = poly.bbox.maxY;
        }
    } else {
        if (!geometry[layerKey]) geometry[layerKey] = [];
        geometry[layerKey].push(...polygons);
    }
}

function handleAddInstances(msg) {
    const { cellName, transforms } = msg;
    if (!instanceTransforms[cellName]) instanceTransforms[cellName] = [];
    instanceTransforms[cellName].push(transforms);
}

function startSearch(x, y) {
    let startPoly = null;
    let hitInstanceContext = null;

    // 1. Check Top-Level Geometry
    for (const layerKey of activeLayers) {
        if (!geometry[layerKey]) continue;
        for (const poly of geometry[layerKey]) {
            if (pointInPolygon(x, y, poly)) {
                startPoly = poly;
                break;
            }
        }
        if (startPoly) break;
    }

    // 2. Check Instances
    if (!startPoly) {
        for (const cellName in instanceTransforms) {
            const transforms = instanceTransforms[cellName];
            const defGeom = definitionGeometry[cellName];
            if (!defGeom) continue;

            let hasActiveLayer = false;
            for (const lk in defGeom) {
                if (activeLayers.has(lk)) {
                    hasActiveLayer = true;
                    break;
                }
            }
            if (!hasActiveLayer) continue;

            for (const transformList of transforms) {
                const count = transformList.length / 9;
                for (let i = 0; i < count; i++) {
                    const offset = i * 9;
                    const m11 = transformList[offset + 0];
                    const m21 = transformList[offset + 1];
                    const m12 = transformList[offset + 3];
                    const m22 = transformList[offset + 4];
                    const tx = transformList[offset + 6];
                    const ty = transformList[offset + 7];

                    const det = m11 * m22 - m12 * m21;
                    if (Math.abs(det) < 1e-6) continue;

                    const invDet = 1.0 / det;
                    const dx = x - tx;
                    const dy = y - ty;
                    const localX = (m22 * dx - m12 * dy) * invDet;
                    const localY = (m11 * dy - m21 * dx) * invDet;

                    for (const layerKey in defGeom) {
                        if (!activeLayers.has(layerKey)) continue;
                        for (const poly of defGeom[layerKey]) {
                            if (pointInPolygon(localX, localY, poly)) {
                                startPoly = transformPolygon(poly, [m11, m12, tx, m21, m22, ty]);
                                hitInstanceContext = { cellName, matrix: [m11, m12, tx, m21, m22, ty], originPoly: poly };
                                break;
                            }
                        }
                        if (startPoly) break;
                    }
                    if (startPoly) break;
                }
                if (startPoly) break;
            }
            if (startPoly) break;
        }
    }

    if (!startPoly) {
        self.postMessage({ command: 'found', polygons: [] });
        return;
    }

    self.postMessage({ command: 'status', message: "Searching connected objects..." });

    const queue = [startPoly];
    const visited = new Set([startPoly]);
    const result = [startPoly];

    const candidates = [];
    for (const layerKey of activeLayers) {
        if (geometry[layerKey]) {
            const layerPolys = geometry[layerKey];
            for (let i = 0; i < layerPolys.length; i++) {
                candidates.push(layerPolys[i]);
            }
        }
    }

    if (hitInstanceContext) {
        const { cellName, matrix, originPoly } = hitInstanceContext;
        const defGeom = definitionGeometry[cellName];
        if (defGeom) {
            for (const layerKey in defGeom) {
                if (!activeLayers.has(layerKey)) continue;
                for (const poly of defGeom[layerKey]) {
                    if (poly === originPoly) {
                        candidates.push(startPoly);
                    } else {
                        const worldPoly = transformPolygon(poly, matrix);
                        candidates.push(worldPoly);
                    }
                }
            }
        }
    }

    const unexpandedInstances = [];
    for (const cellName in instanceTransforms) {
        const defBBox = definitionBBoxes[cellName];
        if (!defBBox) continue;

        const transforms = instanceTransforms[cellName];
        for (const transformList of transforms) {
            const count = transformList.length / 9;
            for (let i = 0; i < count; i++) {
                const offset = i * 9;
                const m11 = transformList[offset + 0];
                const m21 = transformList[offset + 1];
                const m12 = transformList[offset + 3];
                const m22 = transformList[offset + 4];
                const tx = transformList[offset + 6];
                const ty = transformList[offset + 7];

                const matrix = [m11, m12, tx, m21, m22, ty];

                if (hitInstanceContext &&
                    hitInstanceContext.cellName === cellName &&
                    Math.abs(hitInstanceContext.matrix[2] - tx) < 1e-6 &&
                    Math.abs(hitInstanceContext.matrix[5] - ty) < 1e-6) {
                    continue;
                }

                const corners = [
                    { x: defBBox.minX, y: defBBox.minY },
                    { x: defBBox.maxX, y: defBBox.minY },
                    { x: defBBox.maxX, y: defBBox.maxY },
                    { x: defBBox.minX, y: defBBox.maxY }
                ];

                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of corners) {
                    const nx = m11 * p.x + m12 * p.y + tx;
                    const ny = m21 * p.x + m22 * p.y + ty;
                    if (nx < minX) minX = nx;
                    if (nx > maxX) maxX = nx;
                    if (ny < minY) minY = ny;
                    if (ny > maxY) maxY = ny;
                }

                unexpandedInstances.push({
                    cellName,
                    matrix,
                    bbox: { minX, minY, maxX, maxY }
                });
            }
        }
    }

    searchState = {
        queue,
        visited,
        result,
        candidates,
        unexpandedInstances,
        head: 0,
        steps: 0,
        maxSteps: maxSteps
    };
    isSearching = true;
    processSearchChunk();
}

function processSearchChunk() {
    if (!isSearching || !searchState) return;

    const startTime = performance.now();
    const { queue, visited, result, candidates, unexpandedInstances, maxSteps } = searchState;

    while (searchState.head < queue.length && searchState.steps < maxSteps) {
        // Check time budget (e.g. 10ms)
        if (performance.now() - startTime > 10) {
            setTimeout(processSearchChunk, 0);
            return;
        }

        const current = queue[searchState.head++];
        searchState.steps++;

        for (let i = unexpandedInstances.length - 1; i >= 0; i--) {
            const inst = unexpandedInstances[i];
            if (bboxesIntersect(current.bbox, inst.bbox)) {
                const defGeom = definitionGeometry[inst.cellName];
                if (defGeom) {
                    for (const layerKey in defGeom) {
                        if (!activeLayers.has(layerKey)) continue;
                        for (const poly of defGeom[layerKey]) {
                            const worldPoly = transformPolygon(poly, inst.matrix);
                            candidates.push(worldPoly);
                        }
                    }
                }
                if (i < unexpandedInstances.length - 1) {
                    unexpandedInstances[i] = unexpandedInstances[unexpandedInstances.length - 1];
                }
                unexpandedInstances.pop();
            }
        }

        for (const other of candidates) {
            if (visited.has(other)) continue;
            if (!bboxesIntersect(current.bbox, other.bbox)) continue;
            if (polygonsIntersect(current, other)) {
                visited.add(other);
                result.push(other);
                queue.push(other);
            }
        }
    }

    isSearching = false;
    self.postMessage({ command: 'found', polygons: result, limitReached: searchState.steps >= maxSteps });
    searchState = null;
}

function pointInPolygon(x, y, poly) {
    let inside = false;
    const isFlat = poly instanceof Float32Array;
    const len = isFlat ? poly.length / 2 : poly.length;
    for (let i = 0, j = len - 1; i < len; j = i++) {
        const xi = isFlat ? poly[i * 2] : poly[i][0];
        const yi = isFlat ? poly[i * 2 + 1] : poly[i][1];
        const xj = isFlat ? poly[j * 2] : poly[j][0];
        const yj = isFlat ? poly[j * 2 + 1] : poly[j][1];
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function bboxesIntersect(a, b) {
    if (!a || !b) return false;
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function polygonsIntersect(poly1, poly2) {
    const getPt = (poly, i) => {
        if (poly instanceof Float32Array) return { x: poly[i * 2], y: poly[i * 2 + 1] };
        return { x: poly[i][0], y: poly[i][1] };
    };
    const getLen = (poly) => poly instanceof Float32Array ? poly.length / 2 : poly.length;
    const len1 = getLen(poly1);
    const len2 = getLen(poly2);
    for (let i = 0; i < len1; i++) {
        const p = getPt(poly1, i);
        if (pointInPolygon(p.x, p.y, poly2)) return true;
    }
    for (let i = 0; i < len2; i++) {
        const p = getPt(poly2, i);
        if (pointInPolygon(p.x, p.y, poly1)) return true;
    }
    for (let i = 0; i < len1; i++) {
        const p1 = getPt(poly1, i);
        const p2 = getPt(poly1, (i + 1) % len1);
        for (let j = 0; j < len2; j++) {
            const p3 = getPt(poly2, j);
            const p4 = getPt(poly2, (j + 1) % len2);
            if (segmentsIntersect(p1, p2, p3, p4)) return true;
        }
    }
    return false;
}

function segmentsIntersect(a, b, c, d) {
    const ccw = (p1, p2, p3) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
    return (ccw(a, c, d) !== ccw(b, c, d)) && (ccw(a, b, c) !== ccw(a, b, d));
}

function transformPolygon(poly, m) {
    const isFlat = poly instanceof Float32Array;
    const len = isFlat ? poly.length / 2 : poly.length;
    const newPoints = new Float32Array(len * 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < len; i++) {
        const x = isFlat ? poly[i * 2] : poly[i][0];
        const y = isFlat ? poly[i * 2 + 1] : poly[i][1];
        const nx = m[0] * x + m[1] * y + m[2];
        const ny = m[3] * x + m[4] * y + m[5];
        newPoints[i * 2] = nx;
        newPoints[i * 2 + 1] = ny;
        if (nx < minX) minX = nx;
        if (nx > maxX) maxX = nx;
        if (ny < minY) minY = ny;
        if (ny > maxY) maxY = ny;
    }
    newPoints.bbox = { minX, minY, maxX, maxY };
    return newPoints;
}
