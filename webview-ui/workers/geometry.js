try {
    importScripts(earcutCdn);
} catch (e) {
    console.error("Worker: Failed to load earcut", e);
    self.postMessage({ type: 'log', message: "Worker failed to load earcut: " + e });
}

self.onmessage = function (e) {
    const t0 = performance.now();
    try {
        let polygons;
        if (e.data.isBinary) {
            // Parse binary buffer
            const buffer = e.data.buffer;
            const dataView = new DataView(buffer);
            let offset = 0;

            // First 4 bytes is total polygons count
            const totalPolys = dataView.getUint32(offset, true); // Little endian
            offset += 4;

            polygons = [];
            for (let i = 0; i < totalPolys; i++) {
                if (offset + 4 > buffer.byteLength) break;
                const nPoints = dataView.getUint32(offset, true);
                offset += 4;

                // Create Float32Array view for points
                // nPoints * 2 floats * 4 bytes
                const byteLen = nPoints * 2 * 4;

                if (offset + byteLen > buffer.byteLength) {
                    console.error("Worker: Buffer overflow detected", offset, byteLen, buffer.byteLength);
                    break;
                }

                // Safety check for huge polygons (likely garbage)
                if (nPoints > 1000000) {
                    console.error("Worker: Huge polygon detected, skipping", nPoints);
                    offset += byteLen; // Try to skip? Or just break?
                    // If nPoints is garbage, byteLen is garbage, so skipping is unsafe.
                    break;
                }

                const points = new Float32Array(buffer, offset, nPoints * 2);
                polygons.push(points);
                offset += byteLen;
            }
        } else if (e.data.isRaw) {
            polygons = JSON.parse(e.data.polygonsString);
        } else {
            polygons = e.data.polygons;
        }

        const { id } = e.data;

        if (e.data.returnPolygons) {
            const t1 = performance.now();
            // Return raw polygons (Float32Arrays)
            // If binary, we can transfer the buffer back to save memory
            // BUT if we also need to triangulate (for WebGL), we cannot transfer the buffer yet!
            const transfer = (e.data.isBinary && !e.data.alsoTriangulate) ? [e.data.buffer] : [];
            self.postMessage({ id, polygons, duration: t1 - t0 }, transfer);

            if (!e.data.alsoTriangulate) return;
        }

        if (!self.earcut) {
            throw new Error("Earcut library not loaded");
        }

        const vertices = [];
        let triCount = 0;
        for (const flat of polygons) {
            // Polygons are already flat [x,y,x,y...] from Python
            const triangles = earcut(flat);
            triCount += triangles.length / 3;
            for (let i = 0; i < triangles.length; i++) {
                const index = triangles[i];
                vertices.push(flat[index * 2], flat[index * 2 + 1]);
            }
        }

        const floatArray = new Float32Array(vertices);
        const t1 = performance.now();
        self.postMessage({ id, vertices: floatArray, duration: t1 - t0, triCount }, [floatArray.buffer]);
    } catch (err) {
        console.error("Worker processing error:", err);
        self.postMessage({ type: 'error', id: e.data.id, error: err.toString() });
    }
};
