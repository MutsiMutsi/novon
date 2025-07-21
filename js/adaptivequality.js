class AdaptiveQuality {
    constructor(videoElement, qualityLevels) {
        this.videoElement = videoElement;
        this.qualityLevels = qualityLevels;
        this.currentLevelIndex = 0;
        this.lastBufferingTime = 0;

        this.bufferCounter = 0;

        this.bindEvents();
        this.setInitialSource();
    }

    bindEvents() {
        this.videoElement.onwaiting = this.onBuffering.bind(this);
        setInterval(this.checkBufferFullness.bind(this), 5000);
        setInterval(() => {
            this.bufferCounter -= 0.01
            console.log(this.bufferCounter);
        }, 100);
    }

    onBuffering() {
        if (this.bufferCounter < 0.0) {
            this.bufferCounter = 0.0;
        }
        this.bufferCounter += 1.0;

        const currentTime = Date.now();
        const bufferingDuration = currentTime - this.lastBufferingTime;

        if (bufferingDuration > 2000) {
            this.lastBufferingTime = currentTime;
            this.downshiftQuality();
        }
    }

    downshiftQuality() {
        if (this.currentLevelIndex < this.qualityLevels.length - 1) {
            this.currentLevelIndex++;
            //const newBitrate = this.qualityLevels[this.currentLevelIndex].bitrate;
            //this.updateVideoSource(newBitrate);
            console.log("Downshifting to", this.qualityLevels[this.currentLevelIndex].Resolution);
        }
    }

    checkBufferFullness() {
        if (Date.now() - this.lastBufferingTime > 10000 && this.videoElement.clientHeight > this.qualityLevels[this.currentLevelIndex].Resolution) {
            this.upshiftQuality();
        }
    }

    upshiftQuality() {
        if (this.currentLevelIndex > 0) {
            this.currentLevelIndex--;
            //const newBitrate = this.qualityLevels[this.currentLevelIndex].bitrate;
            //this.updateVideoSource(newBitrate);
            console.log("Upshifting to", this.qualityLevels[this.currentLevelIndex].Resolution);
        }
    }

    updateVideoSource(bitrate) {
        const videoSource = new URL(this.videoElement.src);
        videoSource.searchParams.set("bitrate", bitrate);
        this.videoElement.src = videoSource.toString();
        this.videoElement.load();
    }

    setInitialSource() {
        const videoHeight = this.videoElement.clientHeight;

        // Find the first quality level where Resolution height is less than or equal to video height
        const selectedLevel = this.qualityLevels.find(level => {
            const levelHeight = parseInt(level.Resolution, 10);
            return levelHeight <= videoHeight;
        });

        // If no matching level found, choose the lowest bitrate
        if (!selectedLevel) {
            selectedLevel = this.qualityLevels[this.qualityLevels.length - 1];
        }

        //const selectedBitrate = selectedLevel.bitrate;
        //this.updateVideoSource(selectedBitrate);
        console.log("Initial quality set to", selectedLevel.Resolution);
    }
}