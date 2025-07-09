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
            Logger.info('VideoManager: Flip Camera button clicked.');
            try {
                // Stop the current videoRecorder, which also stops tracks and clears srcObject
                if (this.videoRecorder) {
                    Logger.info('VideoManager: Stopping current videoRecorder before flipping.');
                    this.videoRecorder.stop();
                    this.videoRecorder = null; // Ensure it's nullified
                }
                this.isActive = false; // Mark inactive before flipping

                this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';         
                Logger.info(`VideoManager: Toggled facingMode to: ${this.facingMode}`);
                
                // Re-start the video manager with the new facing mode
                await this.start(this.fps, this.onFrame);
                Logger.info('VideoManager: Camera flipped successfully and new stream started.');
            } catch (error) {
                Logger.error('VideoManager: Error flipping camera:', error);
                // Ensure UI reflects stopped state if flipping fails
                this.stop(); 
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
        // Initial dimensions, these will be dynamically updated based on the actual video stream aspect ratio
        this.framePreview.width = 320;
        this.framePreview.height = 240;
        this.videoContainer.appendChild(this.framePreview);

        // Add click handler to toggle preview size
        this.framePreview.addEventListener('click', () => {
            this.framePreview.classList.toggle('enlarged');
        });
    }

    /**
     * Updates the frame preview with new image data, maintaining aspect ratio.
     * @param {string} base64Data - Base64 encoded image data
     * @param {number} originalWidth - Original width of the image frame
     * @param {number} originalHeight - Original height of the image frame
     * @private
     */
    updateFramePreview(base64Data, originalWidth, originalHeight) {
        const img = new Image();
        img.onload = () => {
            const ctx = this.framePreview.getContext('2d');
            ctx.clearRect(0, 0, this.framePreview.width, this.framePreview.height); // Clear before drawing

            // Calculate dimensions to fit into 320x240 (framePreview canvas) while maintaining aspect ratio
            const canvasAspectRatio = this.framePreview.width / this.framePreview.height;
            const imageAspectRatio = originalWidth / originalHeight;

            let drawWidth = this.framePreview.width;
            let drawHeight = this.framePreview.height;

            if (imageAspectRatio > canvasAspectRatio) {
                // Image is wider than canvas, fit by width
                drawHeight = drawWidth / imageAspectRatio;
            } else {
                // Image is taller than canvas, fit by height
                drawWidth = drawHeight * imageAspectRatio;
            }

            // Center the image if it doesn't fill the canvas completely
            const offsetX = (this.framePreview.width - drawWidth) / 2;
            const offsetY = (this.framePreview.height - drawHeight) / 2;

            ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
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
            Logger.info('VideoManager: Attempting to start video manager.');
            this.videoContainer.style.display = 'block';
            Logger.info(`VideoManager: FPS set for capture: ${fps}`);
            
            // Re-initialize VideoRecorder
            this.videoRecorder = new VideoRecorder({fps: fps});
            Logger.info('VideoManager: New VideoRecorder instance created.');
                        
            await this.videoRecorder.start(this.previewVideo,this.facingMode, (base64Data, originalWidth, originalHeight) => {
                if (!this.isActive) {
                    //Logger.debug('VideoManager: Skipping frame - inactive');
                    return;
                }

                const currentTime = Date.now();
                if (currentTime - this.lastFrameTime < this.FRAME_INTERVAL) {
                    return;
                }

                // Pass originalWidth and originalHeight from VideoRecorder to processFrame
                this.processFrame(base64Data, originalWidth, originalHeight, onFrame);
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
     * @param {number} originalWidth - Original width of the image frame
     * @param {number} originalHeight - Original height of the image frame
     * @param {Function} onFrame - Frame callback
     * @private
     */
    processFrame(base64Data, originalWidth, originalHeight, onFrame) {
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

            // Pass the actual image dimensions to updateFramePreview
            this.updateFramePreview(base64Data, originalWidth, originalHeight);
            
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
            Logger.info('VideoManager: Calling videoRecorder.stop().');
            this.videoRecorder.stop(); // This stops the MediaStreamTrack and clears srcObject on previewVideo
            this.videoRecorder = null;
            Logger.info('VideoManager: VideoRecorder instance nullified.');
        } else {
            Logger.info('VideoManager: No active videoRecorder to stop.');
        }
        this.isActive = false;
        
        // Clear the framePreview canvas explicitly
        if (this.framePreview) {
            const ctx = this.framePreview.getContext('2d');
            ctx.clearRect(0, 0, this.framePreview.width, this.framePreview.height);
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
            Logger.info(`VideoManager: Facing mode set to: ${this.facingMode}`);
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
