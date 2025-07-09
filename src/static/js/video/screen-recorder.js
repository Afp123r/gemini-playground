import { Logger } from '../utils/logger.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';

/**
 * @fileoverview Implements a screen recorder for capturing and processing screen frames.
 * It supports previewing the screen capture and sending frames to a callback function.
 */
export class ScreenRecorder {
    /**
     * Creates a new ScreenRecorder instance.
     * @param {Object} [options] - Configuration options for the recorder.
     * @param {number} [options.fps=5] - Frames per second for screen capture.
     * @param {number} [options.quality=0.8] - JPEG quality for captured frames (0.0 - 1.0).
     * @param {number} [options.width=1280] - Width of the captured video.
     * @param {number} [options.height=720] - Height of the captured video.
     * @param {number} [options.maxFrameSize=204800] - Maximum size of a frame in bytes (200KB).
     */
    constructor(options = {}) {
        this.stream = null;
        this.isRecording = false;
        this.onScreenData = null;
        this.frameCanvas = document.createElement('canvas'); // Internal canvas for capturing
        this.frameCtx = this.frameCanvas.getContext('2d');
        this.captureInterval = null;
        this.previewElement = null; // The <video> element in HTML
        this.options = {
            fps: 2, // Lower FPS for screen sharing
            quality: 0.8,
            width: 1280,
            height: 720,
            maxFrameSize: 200 * 1024, // 200KB max per frame
            ...options
        };
        this.frameCount = 0;
    }

    /**
     * Starts screen recording.
     * @param {HTMLVideoElement} previewElement - The video element to display the screen preview.
     * @param {Function} onScreenData - Callback function to receive screen frame data.
     * @throws {ApplicationError} Throws an error if screen sharing permission is denied or if the screen recording fails to start.
     */
    async start(previewElement, onScreenData) {
        try {
            this.onScreenData = onScreenData;
            this.previewElement = previewElement;

            Logger.info('ScreenRecorder: Requesting screen sharing access.');
            // Request screen sharing access with audio
            this.stream = await navigator.mediaDevices.getDisplayMedia({ 
                video: {
                    width: { ideal: this.options.width },
                    height: { ideal: this.options.height },
                    frameRate: { ideal: this.options.fps }
                },
                audio: false // Set to true if you want to capture audio as well
            });

            // Set up preview
            if (this.previewElement) {
                this.previewElement.srcObject = this.stream;
                Logger.info('ScreenRecorder: previewElement.srcObject set with new stream.');
                await new Promise((resolve) => {
                    this.previewElement.onloadedmetadata = () => {
                        this.previewElement.play()
                            .then(() => {
                                Logger.info('ScreenRecorder: Preview video started playing.');
                                // Set canvas size based on video dimensions after metadata is loaded
                                this.frameCanvas.width = this.previewElement.videoWidth;
                                this.frameCanvas.height = this.previewElement.videoHeight;
                                Logger.info(`ScreenRecorder: Canvas size set to ${this.frameCanvas.width}x${this.frameCanvas.height}`);
                                resolve();
                            })
                            .catch(error => {
                                Logger.error('ScreenRecorder: Failed to play preview:', error);
                                resolve(); // Resolve anyway to not block
                            });
                    };
                });
            }

            // Start frame capture loop
            this.isRecording = true;
            this.startFrameCapture();
            
            // Handle stream stop - crucial for automatic cleanup if user stops sharing via browser UI
            this.stream.getVideoTracks()[0].addEventListener('ended', () => {
                Logger.info('ScreenRecorder: Screen sharing stream ended by user/browser.');
                this.stop(); // Call internal stop method
            });

            Logger.info('ScreenRecorder: Screen recording started successfully.');

        } catch (error) {
            if (error.name === 'NotAllowedError') {
                throw new ApplicationError(
                    'Screen sharing permission denied',
                    ErrorCodes.SCREEN_PERMISSION_DENIED,
                    { originalError: error }
                );
            }
            Logger.error('ScreenRecorder: Failed to start screen recording:', error);
            throw new ApplicationError(
                'Failed to start screen recording',
                ErrorCodes.SCREEN_START_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * Starts the frame capture loop.
     * @private
     */
    startFrameCapture() {
        const frameInterval = 1000 / this.options.fps;
        
        this.captureInterval = setInterval(() => {
            if (!this.isRecording || !this.previewElement || !this.onScreenData) {
                //Logger.debug('ScreenRecorder: Skipping capture - not recording or missing elements.');
                return;
            }
            
            try {
                // Ensure video is playing and ready
                if (this.previewElement.readyState >= this.previewElement.HAVE_CURRENT_DATA) {
                    // Update canvas size if needed (e.g., if screen resolution changes during share)
                    if (this.frameCanvas.width !== this.previewElement.videoWidth || this.frameCanvas.height !== this.previewElement.videoHeight) {
                        this.frameCanvas.width = this.previewElement.videoWidth;
                        this.frameCanvas.height = this.previewElement.videoHeight;
                        Logger.info(`ScreenRecorder: Canvas size updated to ${this.frameCanvas.width}x${this.frameCanvas.height}`);
                    }

                    // Draw current video frame to canvas
                    this.frameCtx.drawImage(
                        this.previewElement,
                        0, 0,
                        this.frameCanvas.width,
                        this.frameCanvas.height
                    );

                    // Convert to JPEG with quality setting
                    const jpegData = this.frameCanvas.toDataURL('image/jpeg', this.options.quality);
                    const base64Data = jpegData.split(',')[1];
                    
                    if (this.validateFrame(base64Data)) {
                        this.frameCount++;
                        //Logger.debug(`ScreenRecorder: Screen frame #${this.frameCount} captured`);
                        this.onScreenData(base64Data);
                    }
                }
            } catch (error) {
                Logger.error('ScreenRecorder: Screen frame capture error:', error);
            }
        }, frameInterval);

        Logger.info(`ScreenRecorder: Screen capture interval set at ${this.options.fps} FPS`);
    }

    /**
     * Stops screen recording.
     * @throws {ApplicationError} Throws an error if the screen recording fails to stop.
     */
    stop() {
        Logger.info('ScreenRecorder: Stopping screen recording.');
        try {
            this.isRecording = false;
            
            if (this.captureInterval) {
                clearInterval(this.captureInterval);
                this.captureInterval = null;
                Logger.info('ScreenRecorder: Capture interval cleared.');
            }

            if (this.stream) {
                this.stream.getTracks().forEach(track => {
                    track.stop();
                    Logger.info(`ScreenRecorder: Track stopped: ${track.kind} - ${track.label}`);
                });
                this.stream = null;
                Logger.info('ScreenRecorder: Stream nullified.');
            }

            if (this.previewElement) {
                this.previewElement.pause(); // Pause the preview video
                Logger.info(`ScreenRecorder: previewElement.srcObject before null: ${this.previewElement.srcObject ? 'exists' : 'null'}`);
                this.previewElement.srcObject = null; // Clear srcObject
                this.previewElement.src = ''; // Clear src
                this.previewElement.load(); // Reload to clear buffer
                Logger.info(`ScreenRecorder: previewElement.srcObject after null: ${this.previewElement.srcObject ? 'exists' : 'null'}`);
                // Note: Do NOT nullify previewElement here, as it's a DOM element managed by main.js
                Logger.info('ScreenRecorder: Preview element cleaned.');
            }

            // Clear internal canvas to prevent data accumulation
            if (this.frameCanvas) {
                this.frameCtx.clearRect(0, 0, this.frameCanvas.width, this.frameCanvas.height);
                Logger.info('ScreenRecorder: Internal frameCanvas cleared.');
            }

            Logger.info('ScreenRecorder: Screen recording stopped successfully.');

        } catch (error) {
            Logger.error('ScreenRecorder: Failed to stop screen recording:', error);
            throw new ApplicationError(
                'Failed to stop screen recording',
                ErrorCodes.SCREEN_STOP_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * Validates a captured frame.
     * @param {string} base64Data - Base64 encoded frame data.
     * @returns {boolean} True if the frame is valid, false otherwise.
     * @private
     */
    validateFrame(base64Data) {
        if (!base64Data || !/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
            Logger.error('ScreenRecorder: Invalid screen frame base64 data');
            return false;
        }
        
        if (base64Data.length < 1024) { // Minimum reasonable size for a valid JPEG frame
            Logger.error('ScreenRecorder: Screen frame too small, possibly empty or invalid.');
            return false;
        }
        
        return true;
    }

    /**
     * Checks if screen sharing is supported by the browser.
     * @returns {boolean} True if screen sharing is supported, false otherwise.
     * @throws {ApplicationError} Throws an error if screen sharing is not supported.
     * @static
     */
    static checkBrowserSupport() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new ApplicationError(
                'Screen sharing is not supported in this browser',
                ErrorCodes.SCREEN_NOT_SUPPORTED
            );
        }
        return true;
    }
}
