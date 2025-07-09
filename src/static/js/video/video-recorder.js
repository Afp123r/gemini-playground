import { Logger } from '../utils/logger.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';

/**
 * @fileoverview Implements a video recorder for capturing and processing video frames from a camera.
 * It supports previewing the video and sending frames to a callback function.
 */
export class VideoRecorder {
    /**
     * Creates a new VideoRecorder instance.
     * @param {Object} [options] - Configuration options for the recorder.
     * @param {number} [options.fps=15] - Frames per second for video capture.
     * @param {number} [options.quality=0.7] - JPEG quality for captured frames (0.0 - 1.0).
     * @param {number} [options.width=640] - Width of the captured video.
     * @param {number} [options.height=480] - Height of the captured video.
     * @param {number} [options.maxFrameSize=102400] - Maximum size of a frame in bytes (100KB).
     */
    constructor(options = {}) {
        this.stream = null;
        this.previewElement = null; // The <video> element in HTML
        this.isRecording = false;
        this.onVideoData = null;
        this.frameCanvas = document.createElement('canvas'); // Internal canvas for capturing frames
        this.frameCtx = this.frameCanvas.getContext('2d');
        this.captureInterval = null;
        this.options = {
            fps: options.fps || 1, // 使用传入的fps,默认为1
            quality: 0.6,
            width: 640,
            height: 480,
            maxFrameSize: 100 * 1024, // 100KB max per frame
            ...options
        };
        this.frameCount = 0; // Add frame counter for debugging
        this.actualWidth = this.options.width; // Initialize with default/option width
        this.actualHeight = this.options.height; // Initialize with default/option height
        Logger.info('VideoRecorder: Initialized with options:', this.options);  
    }

    /**
     * Starts video recording.
     * @param {HTMLVideoElement} previewElement - The video element to display the video preview.
     * @param {string} facingMode - 'user' or 'environment' for camera facing.
     * @param {Function} onVideoData - Callback function to receive video frame data.
     * @throws {ApplicationError} Throws an error if the video recording fails to start.
     */
    async start(previewElement, facingMode, onVideoData) {
        try {
            this.previewElement = previewElement;
            this.onVideoData = onVideoData;

            Logger.info(`VideoRecorder: Requesting camera access with facingMode: ${facingMode}`);
            // Request camera access
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                video: {
                    facingMode: facingMode,
                    width: { ideal: this.options.width },
                    height: { ideal: this.options.height }
                }
            });

            if (!this.stream || this.stream.getTracks().length === 0) {
                Logger.error('VideoRecorder: getUserMedia returned no tracks or an invalid stream.');
                throw new Error('No video stream tracks available.');
            }
            Logger.info(`VideoRecorder: getUserMedia successful. Stream has ${this.stream.getTracks().length} tracks.`);

            const videoTrack = this.stream.getVideoTracks()[0];
            const settings = videoTrack.getSettings();
            this.actualWidth = settings.width;
            this.actualHeight = settings.height;
            Logger.info(`VideoRecorder: Actual video resolution received from camera: ${this.actualWidth}x${this.actualHeight}`);

            // Set internal canvas dimensions for frame processing to match actual stream
            // This canvas is for sending frames to the API, not for display
            this.frameCanvas.width = this.actualWidth;
            this.frameCanvas.height = this.actualHeight;
            Logger.info(`VideoRecorder: Internal frameCanvas set to ${this.frameCanvas.width}x${this.frameCanvas.height}`);

            // Set up preview on the HTML <video> element
            this.previewElement.srcObject = this.stream;
            // **CRITICAL FIX:** Set the video element's width and height attributes to its intrinsic resolution
            // This tells the browser the video's native aspect ratio, helping it render correctly.
            this.previewElement.width = this.actualWidth;
            this.previewElement.height = this.actualHeight;
            Logger.info(`VideoRecorder: HTML previewElement attributes set to ${this.previewElement.width}x${this.previewElement.height}`);

            await this.previewElement.play()
                .then(() => Logger.info('VideoRecorder: Preview video started playing.'))
                .catch(error => {
                    Logger.error('VideoRecorder: Failed to play preview video:', error);
                    throw error; // Re-throw to be caught by VideoManager
                });

            // Start frame capture loop
            this.isRecording = true;
            this.startFrameCapture();
            
            // Listen for track ended event (e.g., if camera is disconnected by OS/user)
            videoTrack.addEventListener('ended', () => {
                Logger.info('VideoRecorder: Camera track ended by system/user. Calling stop().');
                this.stop(); // Ensure proper cleanup
            });

            Logger.info('VideoRecorder: Video recording started successfully.');

        } catch (error) {
            Logger.error('VideoRecorder: Failed to start video recording (getUserMedia or play failed):', error);
            throw new ApplicationError(
                'Failed to start video recording',
                ErrorCodes.VIDEO_START_FAILED,
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
            if (!this.isRecording || !this.onVideoData || !this.previewElement) {
                //Logger.debug('VideoRecorder: Skipping frame capture - not recording or missing elements.');
                return;
            }
            
            try {
                // Ensure video is playing and ready to draw
                if (this.previewElement.readyState >= this.previewElement.HAVE_CURRENT_DATA) {
                    // Draw current video frame to internal canvas
                    this.frameCtx.drawImage(
                        this.previewElement,
                        0, 0,
                        this.frameCanvas.width,
                        this.frameCanvas.height
                    );
    
                    // Convert to JPEG
                    const jpegData = this.frameCanvas.toDataURL('image/jpeg', this.options.quality);
                    const base64Data = jpegData.split(',')[1];
                    
                    if (!this.validateFrame(base64Data)) {
                        return;
                    }

                    this.frameCount++;
                    //const size = Math.round(base64Data.length / 1024);
                    //Logger.debug(`VideoRecorder: Frame #${this.frameCount} captured (${size}KB)`);
                    
                    // Pass actual dimensions along with base64Data
                    this.onVideoData(base64Data, this.actualWidth, this.actualHeight); 
                } else {
                    //Logger.debug(`VideoRecorder: Preview element not ready for drawing. ReadyState: ${this.previewElement.readyState}`);
                }
            } catch (error) {
                Logger.error('VideoRecorder: Frame capture error:', error);
            }
        }, frameInterval);

        Logger.info(`VideoRecorder: Video capture interval set at ${this.options.fps} FPS`);
    }

    /**
     * Stops video recording.
     * @throws {ApplicationError} Throws an error if the video recording fails to stop.
     */
    stop() {
        Logger.info('VideoRecorder: Stopping video recording.');
        try {
            this.isRecording = false;
            
            if (this.captureInterval) {
                clearInterval(this.captureInterval);
                this.captureInterval = null;
                Logger.info('VideoRecorder: Capture interval cleared.');
            }

            if (this.stream) {
                this.stream.getTracks().forEach(track => {
                    track.stop(); // Stop all tracks in the stream
                    Logger.info(`VideoRecorder: Track stopped: ${track.kind} - ${track.label}`);
                });
                this.stream = null; // Nullify the stream reference
                Logger.info('VideoRecorder: Stream nullified.');
            }

            if (this.previewElement) {
                this.previewElement.pause(); // Pause the video playback
                this.previewElement.srcObject = null; // Clear the srcObject
                this.previewElement.src = ''; // Clear the src attribute
                this.previewElement.load(); // Force the video element to reload/clear its buffer
                // Note: Do NOT nullify previewElement here, as it's a DOM element managed by main.js
                Logger.info('VideoRecorder: Preview element cleaned.');
            }

            // Clear internal canvas to prevent data accumulation
            if (this.frameCanvas) {
                this.frameCtx.clearRect(0, 0, this.frameCanvas.width, this.frameCanvas.height);
                Logger.info('VideoRecorder: Internal frameCanvas cleared.');
            }

            Logger.info('VideoRecorder: Video recording stopped successfully.');

        } catch (error) {
            Logger.error('VideoRecorder: Failed to stop video recording:', error);
            throw new ApplicationError(
                'Failed to stop video recording',
                ErrorCodes.VIDEO_STOP_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * Checks if video recording is supported by the browser.
     * @returns {boolean} True if video recording is supported, false otherwise.
     * @throws {ApplicationError} Throws an error if video recording is not supported.
     * @static
     */
    static checkBrowserSupport() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new ApplicationError(
                'Video recording is not supported in this browser',
                ErrorCodes.VIDEO_NOT_SUPPORTED
            );
        }
        return true;
    }

    /**
     * Validates a captured frame.
     * @param {string} base64Data - Base64 encoded frame data.
     * @returns {boolean} True if the frame is valid, false otherwise.
     * @private
     */
    validateFrame(base64Data) {
        if (!base64Data || !/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
            Logger.error('VideoRecorder: Invalid base64 data');
            return false;
        }
        
        if (base64Data.length < 1024) { // Minimum reasonable size for a valid JPEG frame
            Logger.error('VideoRecorder: Frame too small, possibly empty or invalid.');
            return false;
        }
        
        return true;
    }

    // The optimizeFrameQuality method is not called in your provided code paths,
    // so it's kept as is but won't affect the current issue.
    /**
     * Optimizes the frame quality to reduce size.
     * @param {string} base64Data - Base64 encoded frame data.
     * @returns {string} Optimized base64 encoded frame data.
     * @private
     */
    async optimizeFrameQuality(base64Data) {
        let quality = this.options.quality;
        let currentSize = base64Data.length;
        
        while (currentSize > this.options.maxFrameSize && quality > 0.3) {
            quality -= 0.1;
            const jpegData = this.frameCanvas.toDataURL('image/jpeg', quality);
            base64Data = jpegData.split(',')[1];
            currentSize = base64Data.length;
        }
        
        return base64Data;
    }
}
