import { Logger } from '../utils/logger.js';
import { VideoRecorder } from './video-recorder.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';

/**
 * @fileoverview Manages video capture and processing with motion detection and frame preview.
 */

/**
 * Manages video capture and processing with motion detection and frame preview
 * @class VideoManager
 */
export class VideoManager {
    /**
     * Creates a new VideoManager instance
     * @constructor
     */
    constructor() {
        // Add at the start of constructor
        if (!document.getElementById('video-container')) {
            throw new ApplicationError(
                'Video container element not found',
                ErrorCodes.INVALID_STATE
            );
        }
        // DOM elements
        this.videoContainer = document.getElementById('video-container');
        this.previewVideo = document.getElementById('preview');
        this.stopVideoButton = document.getElementById('stop-video');
        this.framePreview = document.createElement('canvas'); // This is the canvas for the small preview
        
        // State management
        this.lastFrameData = null;
        this.lastSignificantFrame = null;
        this.frameCount = 0;
        this.lastFrameTime = 0;
        this.videoRecorder = null;
        this.isActive = false;

        // Configuration
        this.MOTION_THRESHOLD = 10;  // Minimum pixel difference to detect motion
        this.FRAME_INTERVAL = 200;   // Minimum ms between frames
        this.FORCE_FRAME_INTERVAL = 10; // Send frame every N frames regardless of motion

        this.setupFramePreview();

        // 摄像头状态，用户切换镜头
        this.facingMode = 'user';
        this.onFrame = null;
        this.fps = null;
        
        // 获取翻转按钮元素并添加事件监听
        this.flipCameraButton = document.getElementById('flip-camera');
        if (!this.flipCameraButton) {
            throw new ApplicationError(
                'Flip camera button element not found',
                ErrorCodes.INVALID_STATE
            );
        }
        
        // 在构造函数中直接绑定事件
        this.flipCameraButton.addEventListener('click', async () => {
            try {
                // Stop the current videoRecorder, which also stops tracks and clears srcObject
                if (this.videoRecorder) {
                    this.videoRecorder.stop();
                    this.videoRecorder = null; // Ensure it's nullified
                }
                this.isActive = false; // Mark inactive before flipping

                Logger.info('Flipping camera');
                this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';         
                
                // Re-start the video manager with the new facing mode
                await this.start(this.fps, this.onFrame);
                Logger.info('Camera flipped successfully');
            } catch (error) {
                Logger.error('Error flipping camera:', error);
                throw new ApplicationError(
                    'Failed to flip camera',
                    ErrorCodes.VIDEO_FLIP_FAILED,
                    { originalError: error }
                );
            }
        });
    }

    /**
     * Sets up the frame preview canvas
     * @private
     */
    setupFramePreview() {
        this.framePreview.id = 'frame-preview';
        this.framePreview.width = 320; // Keep original sizes
        this.framePreview.height = 240;
        this.videoContainer.appendChild(this.framePreview);

        // Add click handler to toggle preview size
        this.framePreview.addEventListener('click', () => {
            this.framePreview.classList.toggle('enlarged');
        });
    }

    /**
     * Updates the frame preview with new image data
     * @param {string} base64Data - Base64 encoded image data
     * @private
     */
    updateFramePreview(base64Data,width,height) {
        const img = new Image();
        img.onload = () => {
            const ctx = this.framePreview.getContext('2d');
            // Clear the canvas before drawing to prevent accumulation/ghosting
            ctx.clearRect(0, 0, this.framePreview.width, this.framePreview.height);
            ctx.drawImage(img, 0, 0, width, height);
        };
        img.src = 'data:image/jpeg;base64,' + base64Data;
    }

    /**
     * Detects motion between two frames
     * @param {Uint8ClampedArray} prevFrame - Previous frame data
     * @param {Uint8ClampedArray} currentFrame - Current frame data
     * @returns {number} Motion score
     * @private
     */
    detectMotion(prevFrame, currentFrame) {
        let diff = 0;
        const pixelsToCheck = prevFrame.length / 4;
        const skipPixels = 2;

        for (let i = 0; i < prevFrame.length; i += 4 * skipPixels) {
            const rDiff = Math.abs(prevFrame[i] - currentFrame[i]);
            const gDiff = Math.abs(prevFrame[i + 1] - currentFrame[i + 1]);
            const bDiff = Math.abs(prevFrame[i + 2] - currentFrame[i + 2]);
            diff += (rDiff + gDiff + bDiff) / 3;
        }

        return diff / (pixelsToCheck / skipPixels);
    }

    /**
     * Starts video capture and processing
     * @param {Function} onFrame - Callback for processed frames
     * @returns {Promise<boolean>} Success status
     * @throws {ApplicationError} If video capture fails
     */
    async start(fps, onFrame) {
        try {
            this.onFrame = onFrame;
            this.fps = fps;
            Logger.info('VideoManager: Starting video manager');
            this.videoContainer.style.display = 'block';
            console.log("VideoManager: FPS set to", fps);
            
            // Re-initialize VideoRecorder
            this.videoRecorder = new VideoRecorder({fps: fps});
                        
            await this.videoRecorder.start(this.previewVideo,this.facingMode, (base64Data) => {
                if (!this.isActive) {
                    //Logger.debug('VideoManager: Skipping frame - inactive');
                    return;
                }

                const currentTime = Date.now();
                if (currentTime - this.lastFrameTime < this.FRAME_INTERVAL) {
                    return;
                }

                this.processFrame(base64Data, onFrame);
            });

            this.isActive = true;
            Logger.info('VideoManager: Video manager started successfully.');
            return true;

        } catch (error) {
            Logger.error('VideoManager: Video manager error during start:', error);
            this.stop(); // Ensure full stop on error
            throw new ApplicationError(
                'Failed to start video manager',
                ErrorCodes.VIDEO_START_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * Processes a single video frame
     * @param {string} base64Data - Base64 encoded frame data
     * @param {Function} onFrame - Frame callback
     * @private
     */
    processFrame(base64Data, onFrame) {
        const img = new Image();
        img.onload = () => {
            // Create a temporary canvas for motion detection, not the preview canvas
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(img, 0, 0);
            const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            
            if (this.lastFrameData) {
                const motionScore = this.detectMotion(this.lastFrameData, imageData.data);
                if (motionScore < this.MOTION_THRESHOLD && this.frameCount % this.FORCE_FRAME_INTERVAL !== 0) {
                    //Logger.debug(`VideoManager: Skipping frame - low motion (score: ${motionScore})`);
                    return;
                }
            }

            // Update the actual framePreview canvas
            // Ensure width/height passed to updateFramePreview are consistent with the canvas's own dimensions
            this.updateFramePreview(base64Data, this.framePreview.width, this.framePreview.height);
            
            this.lastFrameData = imageData.data;
            this.lastSignificantFrame = base64Data;
            this.lastFrameTime = Date.now();
            this.frameCount++;

            const size = Math.round(base64Data.length / 1024);
            //Logger.debug(`VideoManager: Processing frame (${size}KB) - frame #${this.frameCount}`);

            onFrame({
                mimeType: "image/jpeg",
                data: base64Data
            });
        };
        img.src = 'data:image/jpeg;base64,' + base64Data;
    }

    /**
     * Stops video capture and processing
     */
    stop() {
        Logger.info('VideoManager: Stopping video manager.');
        if (this.videoRecorder) {
            this.videoRecorder.stop(); // This stops the MediaStreamTrack and clears srcObject on previewVideo
            this.videoRecorder = null;
            Logger.info('VideoManager: VideoRecorder stopped.');
        }
        this.isActive = false;
        
        // Clear the framePreview canvas explicitly
        if (this.framePreview) {
            const ctx = this.framePreview.getContext('2d');
            ctx.clearRect(0, 0, this.framePreview.width, this.framePreview.height);
            // Optionally, fill with a background color if desired, e.g., ctx.fillStyle = '#000'; ctx.fillRect(0,0, this.framePreview.width, this.framePreview.height);
            Logger.info('VideoManager: framePreview canvas cleared.');
        }

        this.videoContainer.style.display = 'none'; // Hide the main video container
        Logger.info('VideoManager: videoContainer hidden.');

        this.lastFrameData = null;
        this.lastSignificantFrame = null;
        this.frameCount = 0;
        Logger.info('VideoManager: State variables reset.');
    }


    async flipCamera() {
        try {
            Logger.info('VideoManager: Flipping camera initiated.');
            // `stop()` is now called implicitly at the start of `flipCameraButton` event listener
            // This ensures a clean slate before attempting to start a new stream.
            
            this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';         
            await this.start(this.fps,this.onFrame); // Restart with new facing mode
            Logger.info('VideoManager: Camera flipped successfully');
        } catch (error) {
            Logger.error('VideoManager: Error flipping camera:', error);
            throw new ApplicationError(
                'Failed to flip camera',
                ErrorCodes.VIDEO_FLIP_FAILED,
                { originalError: error }
            );
        }
    }
}
