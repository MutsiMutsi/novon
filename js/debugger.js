// Debug overlay system for livestream diagnostics
class LivestreamDebugger {
    constructor() {
        this.metrics = {
            // Buffer metrics
            bufferAhead: 0,
            bufferBehind: 0,
            totalBuffered: 0,
            bufferRanges: [],
            targetBuffer: 5,

            // Segment metrics
            segmentsReceived: 0,
            segmentsAppended: 0,
            lastSegmentTime: null,
            segmentInterval: null,
            missedSegments: 0,
            lateSegments: 0,

            // Playback metrics
            currentTime: 0,
            isPlaying: false,
            playbackRate: 1.0,
            stallCount: 0,
            consecutiveStalls: 0,
            lastStallTime: null,

            // Performance metrics
            decodingTime: 0,
            appendTime: 0,
            sourceBufferUpdating: false,

            // Bandwidth estimation
            bytesReceived: 0,
            lastBandwidthCheck: Date.now(),
            estimatedBandwidth: 0,

            // Errors and warnings
            errors: [],
            warnings: []
        };

        this.createOverlay();
        this.startMonitoring();
    }

    createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'debug-overlay';
        overlay.style.cssText = `
            position: fixed;
            left: 10px;
            bottom: 10px;
            background: rgba(0, 0, 0, 0.85);
            color: #00ff00;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            border-radius: 5px;
            z-index: 10000;
            max-width: 400px;
            max-height: 90vh;
            overflow-y: auto;
            line-height: 1.4;
        `;

        overlay.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <button id="debug-toggle" style="background: #3e3e3eff; color: black; border: none; padding: 2px 8px; cursor: pointer; border-radius: 3px; font-size: 10px;">
                <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="M480-120q-64 0-114.5-33T283-240l-95 54-40-69 103-60q-3-11-5-22.5t-4-22.5H120v-80h122q2-12 4-23.5t5-22.5l-103-60 40-69 94 55q8-14 18.5-27.5T322-612q-2-7-2-14v-14q0-24 7-46t19-41l-66-66 56-57 70 68q17-9 35.5-13.5T480-800q20 0 39 5t36 14l69-69 56 57-66 66q12 19 18.5 41t6.5 46v13.5q0 6.5-2 13.5 11 11 21.5 25t18.5 28l95-54 40 69-104 59q3 11 5.5 22.5T718-440h122v80H718q-2 12-4 23.5t-5 22.5l103 60-40 69-95-55q-32 54-82.5 87T480-120Zm-76-546q17-7 36.5-10.5T480-680q20 0 38.5 3t35.5 10q-8-23-28-38t-46-15q-26 0-47 15.5T404-666Zm76 466q73 0 116.5-61T640-400q0-70-40.5-135T480-600q-78 0-119 64.5T320-400q0 78 43.5 139T480-200Zm-40-80v-240h80v240h-80Z"/></svg>
                </button>
            </div>
            <div id="debug-content" style="display:none;"></div>
        `;

        document.body.appendChild(overlay);

        // Toggle functionality
        document.getElementById('debug-toggle').addEventListener('click', () => {
            const content = document.getElementById('debug-content');
            const btn = document.getElementById('debug-toggle');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                btn.textContent = 'HIDE';
            } else {
                content.style.display = 'none';
                btn.textContent = 'SHOW';
            }
        });
    }

    updateDisplay() {
        const content = document.getElementById('debug-content');
        if (!content) return;

        const m = this.metrics;

        // Color coding helper
        const statusColor = (condition, value) => {
            if (condition === 'good') return `<span style="color: #00ff00;">${value}</span>`;
            if (condition === 'warning') return `<span style="color: #ffaa00;">${value}</span>`;
            return `<span style="color: #ff0000;">${value}</span>`;
        };

        // Buffer status
        const bufferStatus = m.bufferAhead < 2 ? 'critical' : m.bufferAhead < 4 ? 'warning' : 'good';

        // Segment timing status
        const segmentStatus = m.segmentInterval && m.segmentInterval > 3000 ? 'critical' :
            m.segmentInterval && m.segmentInterval > 2500 ? 'warning' : 'good';

        content.innerHTML = `
            <div style="margin-bottom: 10px;">
                <strong style="color: #00aaff;">📊 BUFFER STATUS</strong><br>
                Ahead: ${statusColor(bufferStatus, m.bufferAhead.toFixed(2) + 's')} | 
                Behind: ${m.bufferBehind.toFixed(2)}s<br>
                Target: ${m.targetBuffer.toFixed(1)}s | 
                Total: ${m.totalBuffered.toFixed(2)}s<br>
                Ranges: ${m.bufferRanges.length} 
                ${m.bufferRanges.length > 1 ? statusColor('warning', '(FRAGMENTED!)') : ''}<br>
                ${m.bufferRanges.map((r, i) =>
            `  [${i}] ${r.start.toFixed(2)}s - ${r.end.toFixed(2)}s (${(r.end - r.start).toFixed(2)}s)`
        ).join('<br>')}
            </div>
            
            <div style="margin-bottom: 10px;">
                <strong style="color: #00aaff;">📦 SEGMENTS</strong><br>
                Received: ${m.segmentsReceived} | 
                Appended: ${m.segmentsAppended}<br>
                ${m.segmentInterval ?
                `Interval: ${statusColor(segmentStatus, m.segmentInterval.toFixed(0) + 'ms')}` :
                'Interval: N/A'
            }<br>
                Missed: ${m.missedSegments > 0 ? statusColor('critical', m.missedSegments) : m.missedSegments} | 
                Late: ${m.lateSegments > 0 ? statusColor('warning', m.lateSegments) : m.lateSegments}
            </div>
            
            <div style="margin-bottom: 10px;">
                <strong style="color: #00aaff;">▶️ PLAYBACK</strong><br>
                Status: ${m.isPlaying ? statusColor('good', 'PLAYING') : statusColor('critical', 'BUFFERING')}<br>
                Time: ${m.currentTime.toFixed(2)}s | 
                Rate: ${m.playbackRate.toFixed(2)}x<br>
                Stalls: ${m.stallCount} 
                (${m.consecutiveStalls} consecutive)
                ${m.lastStallTime ? '<br>Last: ' + new Date(m.lastStallTime).toLocaleTimeString() : ''}
            </div>
            
            <div style="margin-bottom: 10px;">
                <strong style="color: #00aaff;">⚡ PERFORMANCE</strong><br>
                Decoding: ${m.decodingTime > 0 ? m.decodingTime.toFixed(2) + 'ms' : 'N/A'}<br>
                Append: ${m.appendTime > 0 ? m.appendTime.toFixed(2) + 'ms' : 'N/A'}<br>
                SB Updating: ${m.sourceBufferUpdating ? statusColor('warning', 'YES') : 'NO'}<br>
                Bandwidth: ${(m.estimatedBandwidth / 1024 / 1024).toFixed(2)} Mbps
            </div>
            
            ${m.warnings.length > 0 ? `
                <div style="margin-bottom: 10px;">
                    <strong style="color: #ffaa00;">⚠️ WARNINGS</strong><br>
                    ${m.warnings.slice(-3).map(w => `• ${w}`).join('<br>')}
                </div>
            ` : ''}
            
            ${m.errors.length > 0 ? `
                <div style="margin-bottom: 10px;">
                    <strong style="color: #ff0000;">❌ ERRORS</strong><br>
                    ${m.errors.slice(-3).map(e => `• ${e}`).join('<br>')}
                </div>
            ` : ''}
        `;
    }

    startMonitoring() {
        setInterval(() => this.updateDisplay(), 100);
    }

    // Methods to call from your code

    updateBufferMetrics(video, sourceBuffer) {

        try {
            if (!sourceBuffer || !video) return;

            const currentTime = video.currentTime;
            this.metrics.currentTime = currentTime;

            // Calculate buffer ahead and behind
            let bufferAhead = 0;
            let bufferBehind = 0;
            let totalBuffered = 0;
            const ranges = [];

            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                ranges.push({ start, end });
                totalBuffered += (end - start);

                if (currentTime >= start && currentTime <= end) {
                    bufferAhead = end - currentTime;
                    bufferBehind = currentTime - start;
                }
            }

            this.metrics.bufferAhead = bufferAhead;
            this.metrics.bufferBehind = bufferBehind;
            this.metrics.totalBuffered = totalBuffered;
            this.metrics.bufferRanges = ranges;

            // Warning for low buffer
            if (bufferAhead < 2 && this.metrics.isPlaying) {
                this.addWarning(`Low buffer: ${bufferAhead.toFixed(2)}s`);
            }

            // Warning for fragmented buffer
            if (ranges.length > 2) {
                this.addWarning(`Buffer fragmented: ${ranges.length} ranges`);
            }
        } catch (error) {

        }
    }

    onSegmentReceived(segmentSize) {
        const now = Date.now();
        this.metrics.segmentsReceived++;
        this.metrics.bytesReceived += segmentSize;

        // Calculate segment interval
        if (this.metrics.lastSegmentTime) {
            const interval = now - this.metrics.lastSegmentTime;
            this.metrics.segmentInterval = interval;

            // Expected segment interval is ~2 seconds for typical livestreams
            if (interval > 3000) {
                this.metrics.lateSegments++;
                this.addWarning(`Late segment: ${interval}ms gap`);
            }
        }

        this.metrics.lastSegmentTime = now;

        // Update bandwidth estimation every 5 seconds
        if (now - this.metrics.lastBandwidthCheck > 5000) {
            const duration = (now - this.metrics.lastBandwidthCheck) / 1000;
            this.metrics.estimatedBandwidth = (this.metrics.bytesReceived * 8) / duration;
            this.metrics.bytesReceived = 0;
            this.metrics.lastBandwidthCheck = now;
        }
    }

    onSegmentAppended(appendDuration) {
        this.metrics.segmentsAppended++;
        this.metrics.appendTime = appendDuration;

        if (appendDuration > 100) {
            this.addWarning(`Slow append: ${appendDuration.toFixed(0)}ms`);
        }
    }

    onPlaybackStateChange(isPlaying) {
        const wasPlaying = this.metrics.isPlaying;
        this.metrics.isPlaying = isPlaying;

        if (!isPlaying && wasPlaying) {
            this.metrics.stallCount++;
            this.metrics.consecutiveStalls++;
            this.metrics.lastStallTime = Date.now();
            this.addWarning(`Playback stalled (total: ${this.metrics.stallCount})`);
        } else if (isPlaying && !wasPlaying) {
            // Reset consecutive stalls on successful playback
            if (this.metrics.consecutiveStalls > 0) {
                setTimeout(() => {
                    this.metrics.consecutiveStalls = 0;
                }, 5000);
            }
        }
    }

    onPlaybackRateChange(rate) {
        this.metrics.playbackRate = rate;
    }

    updateTargetBuffer(target) {
        this.metrics.targetBuffer = target;
    }

    updateSourceBufferState(isUpdating) {
        this.metrics.sourceBufferUpdating = isUpdating;
    }

    onMissedSegment() {
        this.metrics.missedSegments++;
        this.addError('Missed segment detected');
    }

    addWarning(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.metrics.warnings.push(`[${timestamp}] ${message}`);
        if (this.metrics.warnings.length > 10) {
            this.metrics.warnings.shift();
        }
    }

    addError(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.metrics.errors.push(`[${timestamp}] ${message}`);
        if (this.metrics.errors.length > 10) {
            this.metrics.errors.shift();
        }
    }

    recordDecodingTime(duration) {
        this.metrics.decodingTime = duration;
    }
}
