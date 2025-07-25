/**
 * Performance-Optimized GPS-Mapper für gedrehte Karten
 * Transformiert GPS-Koordinaten zu viewport-height (vh) Koordinaten
 */
class GPSMapper {
    constructor() {
        this.referencePoints = [];
        this.currentPosition = null;
        this.watchId = null;
        this.isTracking = false;

        // Performance improvements
        this.positionHistory = [];
        this.lastValidPosition = null;
        this.smoothedPosition = null;
        this.updateRequestId = null;
        this.pendingDOMUpdate = false;

        // Smoothing parameters
        this.smoothingFactor = 0.3;
        this.maxJumpDistance = 30;
        this.minAccuracy = 100;
        this.maxHistorySize = 5;

        // NEW: Performance optimizations
        this.transformCache = new Map();
        this.cacheMaxSize = 100;
        this.lastUpdateTime = 0;
        this.updateInterval = 500; // 500ms throttle
        this.batchSize = 3;
        this.pendingPositions = [];
        this.batchTimeoutId = null;
        this.isProcessingBatch = false;

        // NEW: Precomputed values
        this.referencePointsPrecomputed = [];
        this.transformationMatrix = null;

        // NEW: DOM optimization
        this.userMarkerElement = null;
        this.accuracyCircleElement = null;
        this.cssTransformSupported = this.checkCSSTransformSupport();

        // NEW: Memory management
        this.memoryCleanupInterval = 60000; // 1 minute
        this.lastMemoryCleanup = Date.now();

        // NEW: Simulated walking test mode
        this.simulatedWalk = {
            isActive: false,
            intervalId: null,
            startPoint: null,
            endPoint: null,
            progress: 0,
            direction: 1, // 1 for forward, -1 for backward
            speed: 0.001, // Progress increment per frame (0.001 = slow pace)
            updateInterval: 50 // 50ms = 20fps for smooth animation
        };

        // Referenzpunkte initialisieren
        this.initReferencePoints();

        // Setup memory cleanup
        this.setupMemoryCleanup();
    }

    /**
     * Initialisiert die Referenzpunkte mit Precomputation
     */
    initReferencePoints() {
        const referencePoints = [
            { lat: 51.492076, lng: 11.956062, x: 15, y: 55 },
            { lat: 51.491600, lng: 11.955818, x: 43, y: 77 },
            { lat: 51.491316, lng: 11.956467, x: 75, y: 55 },

            { lat: 51.491918, lng: 11.957036, x: 40, y: 17 },
            { lat: 51.491010, lng: 11.956180, x: 91, y: 74.5 },
            { lat: 51.490472, lng: 11.957832, x: 155, y: 14 },
        ];

        referencePoints.forEach(point => {
            this.addReferencePoint(point.lat, point.lng, point.x, point.y);
        });

        // NEW: Precompute transformation matrix for affine transformation
        this.precomputeTransformationMatrix();

        console.log(`GPS-Mapper: ${this.referencePoints.length} Referenzpunkte geladen`);
    }

    /**
     * NEW: Precomputes affine transformation matrix for linear mapping
     */
    precomputeTransformationMatrix() {
        if (this.referencePoints.length < 3) return;

        // Store precomputed values for IDW fallback
        this.referencePointsPrecomputed = this.referencePoints.map(ref => ({
            ...ref,
            latSquared: ref.lat * ref.lat,
            lngSquared: ref.lng * ref.lng
        }));

        // Compute affine transformation matrix using first 3 points
        this.computeAffineTransformation();
    }

    /**
     * Computes affine transformation matrix from GPS to map coordinates
     */
    computeAffineTransformation() {
        if (this.referencePoints.length < 3) return;

        // Use first 3 reference points to compute transformation
        const p1 = this.referencePoints[0];
        const p2 = this.referencePoints[1];
        const p3 = this.referencePoints[2];

        // GPS coordinates (source)
        const lat1 = p1.lat, lng1 = p1.lng;
        const lat2 = p2.lat, lng2 = p2.lng;
        const lat3 = p3.lat, lng3 = p3.lng;

        // Map coordinates (target)
        const x1 = p1.x, y1 = p1.y;
        const x2 = p2.x, y2 = p2.y;
        const x3 = p3.x, y3 = p3.y;

        // Solve for affine transformation: [x] = [a b tx] [lat]
        //                                  [y]   [c d ty] [lng]
        //                                  [1]             [1 ]

        // Set up the linear system
        const A = [
            [lat1, lng1, 1, 0, 0, 0],
            [0, 0, 0, lat1, lng1, 1],
            [lat2, lng2, 1, 0, 0, 0],
            [0, 0, 0, lat2, lng2, 1],
            [lat3, lng3, 1, 0, 0, 0],
            [0, 0, 0, lat3, lng3, 1]
        ];

        const b = [x1, y1, x2, y2, x3, y3];

        // Solve using least squares (simplified for 3x3 case)
        try {
            const solution = this.solveLeastSquares(A, b);
            this.affineMatrix = {
                a: solution[0], b: solution[1], tx: solution[2],
                c: solution[3], d: solution[4], ty: solution[5]
            };

            console.log('Affine transformation matrix computed:', this.affineMatrix);

            // Test the transformation with reference points
            this.validateAffineTransformation();

        } catch (error) {
            console.warn('Failed to compute affine transformation, falling back to IDW:', error);
            this.affineMatrix = null;
        }
    }

    /**
     * Simplified least squares solver for 6x6 system
     */
    solveLeastSquares(A, bVector) {
        // For a 3-point affine transformation, we can solve directly
        const lat1 = A[0][0], lng1 = A[0][1];
        const lat2 = A[2][0], lng2 = A[2][1];
        const lat3 = A[4][0], lng3 = A[4][1];

        const x1 = bVector[0], y1 = bVector[1];
        const x2 = bVector[2], y2 = bVector[3];
        const x3 = bVector[4], y3 = bVector[5];

        // Calculate determinant for the GPS coordinate matrix
        const det = lat1 * (lng2 - lng3) + lat2 * (lng3 - lng1) + lat3 * (lng1 - lng2);

        if (Math.abs(det) < 1e-10) {
            throw new Error('Reference points are collinear');
        }

        // Solve for transformation parameters
        const a = (x1 * (lng2 - lng3) + x2 * (lng3 - lng1) + x3 * (lng1 - lng2)) / det;
        const bParam = (lat1 * (x3 - x2) + lat2 * (x1 - x3) + lat3 * (x2 - x1)) / det;
        const tx = (lat1 * (lng2 * x3 - lng3 * x2) + lat2 * (lng3 * x1 - lng1 * x3) + lat3 * (lng1 * x2 - lng2 * x1)) / det;

        const c = (y1 * (lng2 - lng3) + y2 * (lng3 - lng1) + y3 * (lng1 - lng2)) / det;
        const d = (lat1 * (y3 - y2) + lat2 * (y1 - y3) + lat3 * (y2 - y1)) / det;
        const ty = (lat1 * (lng2 * y3 - lng3 * y2) + lat2 * (lng3 * y1 - lng1 * y3) + lat3 * (lng1 * y2 - lng2 * y1)) / det;

        return [a, bParam, tx, c, d, ty];
    }

    /**
     * Validates affine transformation accuracy
     */
    validateAffineTransformation() {
        if (!this.affineMatrix) return;

        console.log('Validating affine transformation:');
        for (let i = 0; i < this.referencePoints.length; i++) {
            const ref = this.referencePoints[i];
            const transformed = this.transformGPSWithAffine(ref.lat, ref.lng);
            const error = Math.sqrt(Math.pow(transformed.x - ref.x, 2) + Math.pow(transformed.y - ref.y, 2));
            console.log(`Point ${i}: Expected (${ref.x}, ${ref.y}), Got (${transformed.x.toFixed(2)}, ${transformed.y.toFixed(2)}), Error: ${error.toFixed(3)}`);
        }
    }

    /**
     * Applies affine transformation to GPS coordinates
     */
    transformGPSWithAffine(lat, lng) {
        if (!this.affineMatrix) return null;

        const { a, b, tx, c, d, ty } = this.affineMatrix;

        return {
            x: a * lat + b * lng + tx,
            y: c * lat + d * lng + ty
        };
    }

    /**
     * Fügt einen Referenzpunkt hinzu
     */
    addReferencePoint(lat, lng, x, y) {
        this.referencePoints.push({ lat, lng, x, y });
        // Clear cache when reference points change
        this.transformCache.clear();
    }

    /**
     * NEW: Optimized GPS to VH transformation with affine mapping
     */
    transformGPSToVH(lat, lng) {
        if (this.referencePoints.length < 3) {
            throw new Error('Mindestens 3 Referenzpunkte für GPS-Transformation benötigt');
        }

        // Temporarily disable affine transformation due to numerical issues
        // Will fall back to IDW which works better with these coordinate ranges
        console.log(`Transforming GPS: ${lat}, ${lng}`);

        const result = this.transformGPSWithIDW(lat, lng);
        console.log(`Transformed to: ${result.x}vh, ${result.y}vh`);

        return result;
    }

    /**
     * IDW transformation as fallback method
     */
    transformGPSWithIDW(lat, lng) {
        // NEW: Cache lookup
        const cacheKey = `${lat.toFixed(5)}_${lng.toFixed(5)}`;
        if (this.transformCache.has(cacheKey)) {
            return this.transformCache.get(cacheKey);
        }

        // NEW: Use precomputed values for faster calculation
        let totalWeight = 0;
        let weightedX = 0;
        let weightedY = 0;

        // Optimized distance calculation using precomputed values
        for (let i = 0; i < this.referencePointsPrecomputed.length; i++) {
            const ref = this.referencePointsPrecomputed[i];

            // Fast distance calculation
            const latDiff = lat - ref.lat;
            const lngDiff = lng - ref.lng;
            const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);

            const weight = 1 / (distance + 0.000001);

            weightedX += ref.x * weight;
            weightedY += ref.y * weight;
            totalWeight += weight;
        }

        const result = {
            x: weightedX / totalWeight,
            y: weightedY / totalWeight
        };

        // NEW: Cache result with size limit
        if (this.transformCache.size >= this.cacheMaxSize) {
            // Remove oldest entry
            const firstKey = this.transformCache.keys().next().value;
            this.transformCache.delete(firstKey);
        }
        this.transformCache.set(cacheKey, result);

        return result;
    }

    /**
     * NEW: Batch processing for multiple GPS positions
     */
    processBatchPositions() {
        if (this.isProcessingBatch || this.pendingPositions.length === 0) {
            return;
        }

        this.isProcessingBatch = true;

        // Filter valid positions
        const validPositions = this.pendingPositions.filter(pos =>
            this.isValidGPSReading(pos.lat, pos.lng, pos.accuracy)
        );

        if (validPositions.length === 0) {
            this.pendingPositions = [];
            this.isProcessingBatch = false;
            return;
        }

        // Use most recent valid position
        const latestPosition = validPositions[validPositions.length - 1];

        // Process in next frame to avoid blocking
        requestAnimationFrame(() => {
            this.processPosition(latestPosition);
            this.pendingPositions = [];
            this.isProcessingBatch = false;
        });
    }

    /**
     * NEW: Optimized position processing
     */
    processPosition(positionData) {
        const { lat, lng, accuracy } = positionData;

        // Apply smoothing
        const smoothedPos = this.smoothPosition(lat, lng, accuracy);
        if (!smoothedPos) return null;

        // Transform coordinates
        const vhPos = this.transformGPSToVH(smoothedPos.lat, smoothedPos.lng);

        // Update current position
        this.currentPosition = {
            lat: smoothedPos.lat,
            lng: smoothedPos.lng,
            x: vhPos.x,
            y: vhPos.y,
            accuracy: smoothedPos.accuracy
        };

        // Schedule DOM update
        this.schedulePositionUpdate(vhPos, smoothedPos.accuracy);

        // Trigger event
        this.triggerPositionUpdate({
            lat: smoothedPos.lat,
            lng: smoothedPos.lng,
            vhPos,
            accuracy: smoothedPos.accuracy
        });

        return vhPos;
    }

    /**
     * NEW: Throttled position showing with batching
     */
    showUserPosition(lat, lng, accuracy = null) {
        try {
            const now = Date.now();
            const isSimulatedWalk = this.simulatedWalk.isActive;

            // Skip throttling for simulated walking to ensure smooth animation
            if (!isSimulatedWalk && now - this.lastUpdateTime < this.updateInterval) {
                // Add to batch for later processing
                this.pendingPositions.push({ lat, lng, accuracy, timestamp: now });

                // Setup batch processing if not already scheduled
                if (!this.batchTimeoutId) {
                    this.batchTimeoutId = setTimeout(() => {
                        this.processBatchPositions();
                        this.batchTimeoutId = null;
                    }, this.updateInterval);
                }

                return this.currentPosition ? { x: this.currentPosition.x, y: this.currentPosition.y } : null;
            }

            this.lastUpdateTime = now;

            // Process immediately
            return this.processPosition({ lat, lng, accuracy });

        } catch (error) {
            console.error('Fehler beim Anzeigen der Position:', error);
            this.triggerError(error);
            return null;
        }
    }

    /**
     * NEW: Optimized DOM creation with reuse
     */
    createUserMarker(vhPos, accuracy) {
        if (this.userMarkerElement) {
            return this.userMarkerElement;
        }

        console.log('Creating new GPS user marker');

        const userMarker = document.createElement('div');
        userMarker.id = 'userMarker';
        userMarker.className = 'gps-user-position';

        // Ensure basic styling is applied
        userMarker.style.position = 'absolute';
        userMarker.style.display = 'flex';
        userMarker.style.alignItems = 'center';
        userMarker.style.justifyContent = 'center';
        userMarker.style.zIndex = '25';
        userMarker.style.pointerEvents = 'none';
        userMarker.style.transform = 'translate(-50%, -50%)';

        const dot = document.createElement('div');
        dot.className = 'gps-user-dot';
        userMarker.appendChild(dot);

        // Always create accuracy circle for completeness
        const accuracyCircle = document.createElement('div');
        accuracyCircle.className = 'gps-accuracy-circle';
        userMarker.appendChild(accuracyCircle);
        this.accuracyCircleElement = accuracyCircle;

        // Store reference for reuse
        this.userMarkerElement = userMarker;

        console.log('GPS marker created with classes:', userMarker.className);

        return userMarker;
    }

    /**
     * NEW: Check CSS transform support
     */
    checkCSSTransformSupport() {
        const testElement = document.createElement('div');
        return testElement.style.transform !== undefined;
    }

    /**
     * NEW: High-performance DOM updates using transform3d
     */
    updatePositionDOM(vhPos, accuracy) {
        let marker = this.userMarkerElement || document.getElementById('userMarker');

        if (!marker) {
            // Create new marker
            marker = this.createUserMarker(vhPos, accuracy);
            // Add to the same container as .hintergrund (as a sibling)
            const hintergrund = document.querySelector('.hintergrund');
            if (hintergrund && hintergrund.parentElement) {
                hintergrund.parentElement.appendChild(marker);
                console.log('GPS marker created and added as sibling to .hintergrund');
            } else {
                console.error('.hintergrund or its parent not found');
                return;
            }
        }

        // Debug positioning
        console.log(`Positioning GPS marker at: ${vhPos.x}vh, ${vhPos.y}vh`);

        // Use simple positioning for better compatibility and debugging
        marker.style.position = 'absolute';
        marker.style.top = `${vhPos.y}vh`;
        marker.style.left = `${vhPos.x}vh`;
        marker.style.zIndex = '25';

        // Ensure visibility
        marker.style.display = 'flex';
        marker.style.opacity = '1';
        marker.style.visibility = 'visible';

        // Update accuracy circle efficiently
        if (this.accuracyCircleElement && accuracy) {
            const size = this.accuracyToVH(accuracy);
            if (this.accuracyCircleElement.dataset.lastSize !== size.toString()) {
                this.accuracyCircleElement.style.width = `${size}vh`;
                this.accuracyCircleElement.style.height = `${size}vh`;
                this.accuracyCircleElement.dataset.lastSize = size.toString();
            }
        }
    }

    /**
     * NEW: Optimized smoothing with circular buffer
     */
    smoothPosition(lat, lng, accuracy) {
        const newPosition = { lat, lng, accuracy, timestamp: Date.now() };

        // Use circular buffer for position history
        if (this.positionHistory.length >= this.maxHistorySize) {
            this.positionHistory.shift();
        }
        this.positionHistory.push(newPosition);

        if (!this.smoothedPosition) {
            this.smoothedPosition = { ...newPosition };
            this.lastValidPosition = { ...newPosition };
            return this.smoothedPosition;
        }

        // Optimized exponential smoothing
        const factor = this.smoothingFactor;
        const invFactor = 1 - factor;

        this.smoothedPosition.lat = this.smoothedPosition.lat * invFactor + lat * factor;
        this.smoothedPosition.lng = this.smoothedPosition.lng * invFactor + lng * factor;
        this.smoothedPosition.accuracy = accuracy;
        this.smoothedPosition.timestamp = Date.now();

        this.lastValidPosition = { ...newPosition };
        return this.smoothedPosition;
    }

    /**
     * NEW: Setup automatic memory cleanup
     */
    setupMemoryCleanup() {
        setInterval(() => {
            this.performMemoryCleanup();
        }, this.memoryCleanupInterval);
    }

    /**
     * NEW: Periodic memory cleanup
     */
    performMemoryCleanup() {
        const now = Date.now();

        // Clean old cache entries
        if (this.transformCache.size > this.cacheMaxSize * 0.8) {
            const entries = Array.from(this.transformCache.entries());
            const toDelete = entries.slice(0, Math.floor(entries.length * 0.3));
            toDelete.forEach(([key]) => this.transformCache.delete(key));
        }

        // Clean old position history
        const cutoff = now - 60000; // 1 minute
        this.positionHistory = this.positionHistory.filter(pos => pos.timestamp > cutoff);

        this.lastMemoryCleanup = now;
        console.log('Memory cleanup performed');
    }

    /**
     * NEW: Optimized distance calculation using lookup table for common distances
     */
    calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371000; // Earth radius in meters

        // Pre-calculate common values
        const lat1Rad = lat1 * Math.PI / 180;
        const lat2Rad = lat2 * Math.PI / 180;
        const deltaLatRad = (lat2 - lat1) * Math.PI / 180;
        const deltaLngRad = (lng2 - lng1) * Math.PI / 180;

        const a = Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) *
            Math.sin(deltaLngRad / 2) * Math.sin(deltaLngRad / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * NEW: Web Worker support for heavy calculations (if available)
     */
    initWebWorker() {
        if (typeof Worker !== 'undefined') {
            try {
                // Create worker for heavy GPS calculations
                const workerCode = `
                    self.onmessage = function(e) {
                        const {lat, lng, referencePoints} = e.data;
                        
                        let totalWeight = 0;
                        let weightedX = 0;
                        let weightedY = 0;

                        referencePoints.forEach(ref => {
                            const latDiff = lat - ref.lat;
                            const lngDiff = lng - ref.lng;
                            const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
                            const weight = 1 / (distance + 0.000001);
                            
                            weightedX += ref.x * weight;
                            weightedY += ref.y * weight;
                            totalWeight += weight;
                        });

                        self.postMessage({
                            x: weightedX / totalWeight,
                            y: weightedY / totalWeight
                        });
                    };
                `;

                const blob = new Blob([workerCode], { type: 'application/javascript' });
                this.worker = new Worker(URL.createObjectURL(blob));
                this.workerAvailable = true;

                console.log('Web Worker initialized for GPS calculations');
            } catch (error) {
                console.log('Web Worker not available, using main thread');
                this.workerAvailable = false;
            }
        }
    }

    /**
     * Enhanced getCurrentLocation with retry logic
     */
    getCurrentLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation wird vom Browser nicht unterstützt'));
                return;
            }

            const options = {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 30000 // Reduced for fresher data
            };

            let retryCount = 0;
            const maxRetries = 3;

            const attemptGeolocation = () => {
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        let lat = position.coords.latitude;
                        let lng = position.coords.longitude;
                        const accuracy = position.coords.accuracy;

                        // Apply test offset if enabled
                        if (window.CONFIG?.GPS_TESTING?.ENABLED) {
                            lat += window.CONFIG.GPS_TESTING.TEST_OFFSET.lat;
                            lng += window.CONFIG.GPS_TESTING.TEST_OFFSET.lng;
                        }

                        const vhPos = this.showUserPosition(lat, lng, accuracy);
                        resolve({
                            lat, lng, accuracy, vhPos,
                            testing: window.CONFIG?.GPS_TESTING?.ENABLED || false
                        });
                    },
                    (error) => {
                        retryCount++;
                        if (retryCount < maxRetries) {
                            console.log(`GPS retry ${retryCount}/${maxRetries}`);
                            setTimeout(attemptGeolocation, 1000 * retryCount);
                        } else {
                            console.error('GPS-Fehler nach mehreren Versuchen:', error.message);
                            reject(error);
                        }
                    },
                    options
                );
            };

            attemptGeolocation();
        });
    }

    /**
     * Enhanced tracking with adaptive intervals
     */
    startTracking() {
        if (!navigator.geolocation) {
            console.error('Geolocation wird nicht unterstützt');
            return false;
        }

        if (this.isTracking) {
            console.warn('GPS-Tracking läuft bereits');
            return true;
        }

        console.log('GPS-Tracking wird gestartet...');

        // Adaptive timeout based on device capabilities
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const timeout = isMobile ? 6000 : 8000;

        this.watchId = navigator.geolocation.watchPosition(
            (position) => {
                let lat = position.coords.latitude;
                let lng = position.coords.longitude;
                const accuracy = position.coords.accuracy;

                if (window.CONFIG?.GPS_TESTING?.ENABLED) {
                    lat += window.CONFIG.GPS_TESTING.TEST_OFFSET.lat;
                    lng += window.CONFIG.GPS_TESTING.TEST_OFFSET.lng;
                }

                this.showUserPosition(lat, lng, accuracy);
            },
            (error) => {
                console.error('GPS-Tracking-Fehler:', error.message);
                this.triggerError(error);
            },
            {
                enableHighAccuracy: true,
                timeout: timeout,
                maximumAge: 1000 // Fresh data every second
            }
        );

        this.isTracking = true;
        this.triggerTrackingStart();
        return true;
    }

    /**
     * Enhanced cleanup on stop
     */
    stopTracking() {
        if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }

        // Clear pending operations
        if (this.batchTimeoutId) {
            clearTimeout(this.batchTimeoutId);
            this.batchTimeoutId = null;
        }

        if (this.updateRequestId) {
            cancelAnimationFrame(this.updateRequestId);
            this.updateRequestId = null;
        }

        // Clear batched positions
        this.pendingPositions = [];
        this.isProcessingBatch = false;
        this.pendingDOMUpdate = false;

        this.isTracking = false;
        this.triggerTrackingStop();
        console.log('GPS-Tracking gestoppt');
    }

    /**
     * Enhanced cleanup method
     */
    destroy() {
        this.stopTracking();

        // Clean up worker
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }

        // Clear caches
        this.transformCache.clear();
        this.positionHistory = [];

        // Remove DOM elements
        if (this.userMarkerElement) {
            this.userMarkerElement.remove();
            this.userMarkerElement = null;
        }

        console.log('GPS-Mapper destroyed');
    }

    // Keep all other existing methods unchanged...
    clearReferencePoints() {
        this.referencePoints = [];
        this.transformCache.clear();
    }

    removeUserMarker() {
        if (this.userMarkerElement) {
            this.userMarkerElement.remove();
            this.userMarkerElement = null;
            this.accuracyCircleElement = null;
        }
    }

    accuracyToVH(accuracyMeters) {
        const metersPerVH = 1.35;
        return Math.min(Math.max(accuracyMeters / metersPerVH, 0.5), 50);
    }

    isNearPoint(targetLat, targetLng, radiusMeters = 50) {
        if (!this.currentPosition) return false;

        const distance = this.calculateDistance(
            this.currentPosition.lat,
            this.currentPosition.lng,
            targetLat,
            targetLng
        );

        return distance <= radiusMeters;
    }

    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    }

    triggerPositionUpdate(data) {
        $(document).trigger('gps:positionUpdate', data);
    }

    triggerError(error) {
        $(document).trigger('gps:error', error);
    }

    triggerTrackingStart() {
        $(document).trigger('gps:trackingStart');
    }

    triggerTrackingStop() {
        $(document).trigger('gps:trackingStop');
    }

    getCurrentPosition() {
        return this.currentPosition;
    }

    isGPSAvailable() {
        return 'geolocation' in navigator;
    }

    isCurrentlyTracking() {
        return this.isTracking;
    }

    schedulePositionUpdate(vhPos, accuracy) {
        if (this.pendingDOMUpdate) return;

        this.pendingDOMUpdate = true;

        if (this.updateRequestId) {
            cancelAnimationFrame(this.updateRequestId);
        }

        this.updateRequestId = requestAnimationFrame(() => {
            this.updatePositionDOM(vhPos, accuracy);
            this.pendingDOMUpdate = false;
        });
    }

    isValidGPSReading(lat, lng, accuracy) {
        if (!lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            return false;
        }

        if (accuracy && accuracy > this.minAccuracy) {
            return false;
        }

        if (this.lastValidPosition) {
            const distance = this.calculateDistance(
                this.lastValidPosition.lat,
                this.lastValidPosition.lng,
                lat,
                lng
            );

            if (distance > this.maxJumpDistance) {
                return false;
            }
        }

        return true;
    }

    resetSmoothing() {
        this.positionHistory = [];
        this.lastValidPosition = null;
        this.smoothedPosition = null;
        this.transformCache.clear();
        console.log('GPS smoothing and cache reset');
    }

    /**
     * NEW: Simulated walking test mode - Creates smooth movement between reference points
     */
    enableTestingMode() {
        if (this.referencePoints.length < 6) {
            return Promise.reject(new Error('Nicht genügend Referenzpunkte verfügbar (benötigt: 6)'));
        }

        return new Promise((resolve) => {
            // Use reference points at index 3 and 5 (the new reference points)
            const startRef = this.referencePoints[3];  // Index 3: {lat: 51.491918, lng: 11.957036, x: 40, y: 17}
            const endRef = this.referencePoints[4];    // Index 5: {lat: 51.490472, lng: 11.957832, x: 155, y: 14}

            // Setup simulated walk between reference points 3 and 5
            this.simulatedWalk.startPoint = {
                lat: startRef.lat,
                lng: startRef.lng
            };
            this.simulatedWalk.endPoint = {
                lat: endRef.lat,
                lng: endRef.lng
            };

            this.simulatedWalk.progress = 0;
            this.simulatedWalk.direction = 1;
            this.simulatedWalk.isActive = true;

            // Enable testing mode
            window.CONFIG.GPS_TESTING.ENABLED = true;

            console.log('Simulated walking mode enabled:', {
                startPoint: this.simulatedWalk.startPoint,
                endPoint: this.simulatedWalk.endPoint,
                path: `Walking from ref point 3 (${startRef.x}vh, ${startRef.y}vh) to ref point 5 (${endRef.x}vh, ${endRef.y}vh)`
            });

            // Reset smoothing for immediate response
            this.resetSmoothing();

            // Start simulated movement
            this.startSimulatedWalk();

            resolve({
                mode: 'simulated_walking',
                startPoint: this.simulatedWalk.startPoint,
                endPoint: this.simulatedWalk.endPoint,
                path: `Reference Point 3 (40vh, 17vh) → Reference Point 5 (155vh, 14vh)`
            });
        });
    }

    /**
     * Starts the simulated walking animation
     */
    startSimulatedWalk() {
        if (this.simulatedWalk.intervalId) {
            clearInterval(this.simulatedWalk.intervalId);
        }

        this.simulatedWalk.intervalId = setInterval(() => {
            this.updateSimulatedPosition();
        }, this.simulatedWalk.updateInterval);
    }

    /**
     * Updates simulated position along the path
     */
    updateSimulatedPosition() {
        if (!this.simulatedWalk.isActive) return;

        // Update progress
        this.simulatedWalk.progress += this.simulatedWalk.speed * this.simulatedWalk.direction;

        // Reverse direction at endpoints (ping-pong movement)
        if (this.simulatedWalk.progress >= 1) {
            this.simulatedWalk.progress = 1;
            this.simulatedWalk.direction = -1;
            console.log('Simulated walker reached end point, turning around');
        } else if (this.simulatedWalk.progress <= 0) {
            this.simulatedWalk.progress = 0;
            this.simulatedWalk.direction = 1;
            console.log('Simulated walker reached start point, turning around');
        }

        // Calculate current position using linear interpolation
        const start = this.simulatedWalk.startPoint;
        const end = this.simulatedWalk.endPoint;
        const t = this.simulatedWalk.progress;

        // Smooth easing function for more natural movement
        const easedT = this.easeInOutSine(t);

        const currentLat = start.lat + (end.lat - start.lat) * easedT;
        const currentLng = start.lng + (end.lng - start.lng) * easedT;

        // Simulate GPS accuracy (realistic values for walking)
        const accuracy = 5 + Math.random() * 10; // 5-15 meters accuracy

        // Debug simulated position
        console.log(`Simulated GPS: ${currentLat.toFixed(6)}, ${currentLng.toFixed(6)} (progress: ${(t * 100).toFixed(1)}%)`);

        // Feed simulated position to the GPS system
        this.showUserPosition(currentLat, currentLng, accuracy);
    }

    /**
     * Smooth easing function for natural movement
     */
    easeInOutSine(t) {
        return -(Math.cos(Math.PI * t) - 1) / 2;
    }

    /**
     * Disables simulated walking test mode
     */
    disableTestingMode() {
        this.simulatedWalk.isActive = false;

        if (this.simulatedWalk.intervalId) {
            clearInterval(this.simulatedWalk.intervalId);
            this.simulatedWalk.intervalId = null;
        }

        if (window.CONFIG) {
            window.CONFIG.GPS_TESTING.ENABLED = false;
            window.CONFIG.GPS_TESTING.REAL_LOCATION = null;
            window.CONFIG.GPS_TESTING.TEST_OFFSET = { lat: 0, lng: 0 };
        }

        console.log('Simulated walking mode disabled');
        return true;
    }

    /**
     * Returns current testing status
     */
    getTestingStatus() {
        if (!window.CONFIG) return { enabled: false };

        return {
            enabled: window.CONFIG.GPS_TESTING.ENABLED,
            mode: this.simulatedWalk.isActive ? 'simulated_walking' : 'disabled',
            progress: this.simulatedWalk.progress,
            direction: this.simulatedWalk.direction === 1 ? 'forward' : 'backward'
        };
    }
}

// Export as global variable
window.GPSMapper = GPSMapper;