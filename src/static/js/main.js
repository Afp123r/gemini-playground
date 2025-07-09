import { MultimodalLiveClient } from './core/websocket-client.js';
import { AudioStreamer } from './audio/audio-streamer.js';
import { AudioRecorder } from './audio/audio-recorder.js';
import { CONFIG } from './config/config.js';
import { Logger } from './utils/logger.js';
import { VideoManager } from './video/video-manager.js';
import { ScreenRecorder } from './video/screen-recorder.js';

/**
 * @fileoverview Main entry point for the application.
 * Initializes and manages the UI, audio, video, and WebSocket interactions.
 */

// DOM Elements
const logsContainer = document.getElementById('logs-container');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const micButton = document.getElementById('mic-button');
const micIcon = document.getElementById('mic-icon');
const audioVisualizer = document.getElementById('audio-visualizer');
const connectButton = document.getElementById('connect-button');
const cameraButton = document.getElementById('camera-button');
const cameraIcon = document.getElementById('camera-icon');
const stopVideoButton = document.getElementById('stop-video');
const screenButton = document.getElementById('screen-button');
const screenIcon = document.getElementById('screen-icon');
const screenContainer = document.getElementById('screen-container');
const screenPreview = document.getElementById('screen-preview');
const inputAudioVisualizer = document.getElementById('input-audio-visualizer');
const apiKeyInput = document.getElementById('api-key');
const voiceSelect = document.getElementById('voice-select');
const fpsInput = document.getElementById('fps-input');
const configToggle = document.getElementById('config-toggle');
const configContainer = document.getElementById('config-container');
const systemInstructionInput = document.getElementById('system-instruction');
// 确保系统指令被硬编码并显示
systemInstructionInput.value = "You are my helpful assistant. You can see and hear me, and and respond with voice and text. If you are asked about things you do not know, you can use the google search tool to find the answer.\n请根据我说话的语言进行回复。如果我用中文说话，请用中文回复；如果我用英文说话，请用英文回复。";

const applyConfigButton = document.getElementById('apply-config');
const responseTypeSelect = document.getElementById('response-type-select');
const languageSelect = document.getElementById('language-select');

// 获取视频容器和视频元素
const videoContainer = document.getElementById('video-container');
const preview = document.getElementById('preview');


// Load saved values from localStorage
const savedApiKey = localStorage.getItem('gemini_api_key');
const savedVoice = localStorage.getItem('gemini_voice');
const savedFPS = localStorage.getItem('video_fps');
const savedLanguage = localStorage.getItem('gemini_language');

if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
}
if (savedVoice) {
    voiceSelect.value = savedVoice;
}
if (savedFPS) {
    fpsInput.value = savedFPS;
}
if (savedLanguage) {
    languageSelect.value = savedLanguage;
}


// Handle configuration panel toggle
configToggle.addEventListener('click', () => {
    configContainer.classList.toggle('active');
    configToggle.classList.toggle('active');
});

applyConfigButton.addEventListener('click', () => {
    configContainer.classList.toggle('active');
    configToggle.classList.toggle('active');
});

// State variables
let isRecording = false;
let audioStreamer = null;
let audioCtx = null;
let isConnected = false;
let audioRecorder = null;
let isVideoActive = false;
let videoManager = null;
let isScreenSharing = false;
let screenRecorder = null;
let isUsingTool = false;

// Multimodal Client
const client = new MultimodalLiveClient();

/**
 * Logs a message to the UI.
 * @param {string} message - The message to log.
 * @param {string} [type='system'] - The type of the message (system, user, ai).
 */
function logMessage(message, type = 'system') {
    const logEntry = document.createElement('div');
    logEntry.classList.add('log-entry', type);

    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = new Date().toLocaleTimeString();
    logEntry.appendChild(timestamp);

    const emoji = document.createElement('span');
    emoji.classList.add('emoji');
    switch (type) {
        case 'system':
            emoji.textContent = '⚙️';
            break;
        case 'user':
            emoji.textContent = '🫵';
            break;
        case 'ai':
            emoji.textContent = '🤖';
            break;
    }
    logEntry.appendChild(emoji);

    const messageText = document.createElement('span');
    messageText.textContent = message;
    logEntry.appendChild(messageText);

    logsContainer.appendChild(logEntry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

/**
 * Updates the microphone icon based on the recording state.
 */
function updateMicIcon() {
    micIcon.textContent = isRecording ? 'mic_off' : 'mic';
    micButton.style.backgroundColor = isRecording ? '#ea4335' : '#4285f4';
}

/**
 * Updates the audio visualizer based on the audio volume.
 * @param {number} volume - The audio volume (0.0 to 1.0).
 * @param {boolean} [isInput=false] - Whether the visualizer is for input audio.
 */
function updateAudioVisualizer(volume, isInput = false) {
    const visualizer = isInput ? inputAudioVisualizer : audioVisualizer;
    const audioBar = visualizer.querySelector('.audio-bar') || document.createElement('div');
    
    if (!visualizer.contains(audioBar)) {
        audioBar.classList.add('audio-bar');
        visualizer.appendChild(audioBar);
    }
    
    audioBar.style.width = `${volume * 100}%`;
    if (volume > 0) {
        audioBar.classList.add('active');
    } else {
        audioBar.classList.remove('active');
    }
}

/**
 * Initializes the audio context and streamer if not already initialized.
 * @returns {Promise<AudioStreamer>} The audio streamer instance.
 */
async function ensureAudioInitialized() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
    }
    if (!audioStreamer) {
        audioStreamer = new AudioStreamer(audioCtx);
        await audioStreamer.addWorklet('vumeter-out', 'js/audio/worklets/vol-meter.js', (ev) => {
            updateAudioVisualizer(ev.data.volume);
        });
    }
    return audioStreamer;
}

/**
 * Handles the microphone toggle. Starts or stops audio recording.
 * @returns {Promise<void>}
 */
async function handleMicToggle() {
    if (!isRecording) {
        try {
            await ensureAudioInitialized();
            audioRecorder = new AudioRecorder();
            
            const inputAnalyser = audioCtx.createAnalyser();
            inputAnalyser.fftSize = 256;
            const inputDataArray = new Uint8Array(inputAnalyser.frequencyBinCount);
            
            await audioRecorder.start((base64Data) => {
                if (isUsingTool) {
                    client.sendRealtimeInput([{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64Data,
                        interrupt: true     // Model isn't interruptable when using tools, so we do it manually
                    }]);
                } else {
                    client.sendRealtimeInput([{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64Data
                    }]);
                }
                
                inputAnalyser.getByteFrequencyData(inputDataArray);
                const inputVolume = Math.max(...inputDataArray) / 255;
                updateAudioVisualizer(inputVolume, true);
            });

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const source = audioCtx.createMediaStreamSource(stream);
            source.connect(inputAnalyser);
            
            await audioStreamer.resume();
            isRecording = true;
            Logger.info('Microphone started');
            logMessage('Microphone started', 'system');
            updateMicIcon();
        } catch (error) {
            Logger.error('Microphone error:', error);
            logMessage(`Error: ${error.message}`, 'system');
            isRecording = false;
            updateMicIcon();
        }
    } else {
        if (audioRecorder && isRecording) {
            audioRecorder.stop();
        }
        isRecording = false;
        logMessage('Microphone stopped', 'system');
        updateMicIcon();
        updateAudioVisualizer(0, true);
    }
}

/**
 * Resumes the audio context if it's suspended.
 * @returns {Promise<void>}
 */
async function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

/**
 * Connects to the WebSocket server.
 * @returns {Promise<void>}
 */
async function connectToWebsocket() {
    if (!apiKeyInput.value) {
        logMessage('Please input API Key', 'system');
        return;
    }

    // Save values to localStorage
    localStorage.setItem('gemini_api_key', apiKeyInput.value);
    localStorage.setItem('gemini_voice', voiceSelect.value);
    localStorage.setItem('gemini_language', languageSelect.value);

    const config = {
        model: CONFIG.API.MODEL_NAME,
        generationConfig: {
            responseModalities: responseTypeSelect.value,
            speechConfig: {
				languageCode: languageSelect.value,
                voiceConfig: { 
                    prebuiltVoiceConfig: { 
                        voiceName: voiceSelect.value
                    }
                }
            },

        },
        systemInstruction: {
            parts: [{
                // 硬编码系统指令在这里，确保它始终被发送给 API
                text: "You are my helpful assistant. You can see and hear me, and respond with voice and text. If you are asked about things you do not know, you can use the google search tool to find the answer.\n请根据我说话的语言进行回复。如果我用中文说话，请用中文回复；如果我用英文说话，请用英文回复。"
            }],
        }
    };  

    try {
        await client.connect(config,apiKeyInput.value);
        isConnected = true;
        await resumeAudioContext();
        connectButton.textContent = 'Disconnect';
        connectButton.classList.add('connected');
        messageInput.disabled = false;
        sendButton.disabled = false;
        micButton.disabled = false;
        cameraButton.disabled = false;
        screenButton.disabled = false;
        logMessage('Connected to Gemini 2.0 Flash Multimodal Live API', 'system');
    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        Logger.error('Connection error:', error);
        logMessage(`Connection error: ${errorMessage}`, 'system');
        isConnected = false;
        connectButton.textContent = 'Connect';
        connectButton.classList.remove('connected');
        messageInput.disabled = true;
        sendButton.disabled = true;
        micButton.disabled = true;
        cameraButton.disabled = true;
        screenButton.disabled = true;
    }
}

/**
 * Disconnects from the WebSocket server.
 */
function disconnectFromWebsocket() {
    client.disconnect();
    isConnected = false;
    if (audioStreamer) {
        audioStreamer.stop();
        if (audioRecorder) {
            audioRecorder.stop();
            audioRecorder = null;
        }
        isRecording = false;
        updateMicIcon();
    }
    connectButton.textContent = 'Connect';
    connectButton.classList.remove('connected');
    messageInput.disabled = true;
    sendButton.disabled = true;
    micButton.disabled = true;
    cameraButton.disabled = true;
    screenButton.disabled = true;
    logMessage('Disconnected from server', 'system');
    
    // 确保在断开连接时停止并清除视频/屏幕共享
    if (videoManager) {
        stopVideo();
    }
    
    if (screenRecorder) {
        stopScreenSharing();
    }
}

/**
 * Handles sending a text message.
 */
function handleSendMessage() {
    const message = messageInput.value.trim();
    if (message) {
        logMessage(message, 'user');
        client.send({ text: message });
        messageInput.value = '';
    }
}

// Event Listeners
client.on('open', () => {
    logMessage('WebSocket connection opened', 'system');
});

client.on('log', (log) => {
    logMessage(`${log.type}: ${JSON.stringify(log.message)}`, 'system');
});

client.on('close', (event) => {
    logMessage(`WebSocket connection closed (code ${event.code})`, 'system');
});

client.on('audio', async (data) => {
    try {
        await resumeAudioContext();
        const streamer = await ensureAudioInitialized();
        streamer.addPCM16(new Uint8Array(data));
    } catch (error) {
        logMessage(`Error processing audio: ${error.message}`, 'system');
    }
});

client.on('content', (data) => {
    if (data.modelTurn) {
        if (data.modelTurn.parts.some(part => part.functionCall)) {
            isUsingTool = true;
            Logger.info('Model is using a tool');
        } else if (data.modelTurn.parts.some(part => part.functionResponse)) {
            isUsingTool = false;
            Logger.info('Tool usage completed');
        }

        const text = data.modelTurn.parts.map(part => part.text).join('');
        if (text) {
            logMessage(text, 'ai');
        }
    }
});

client.on('interrupted', () => {
    audioStreamer?.stop();
    isUsingTool = false;
    Logger.info('Model interrupted');
    logMessage('Model interrupted', 'system');
});

client.on('setupcomplete', () => {
    logMessage('Setup complete', 'system');
});

client.on('turncomplete', () => {
    isUsingTool = false;
    logMessage('Turn complete', 'system');
});

client.on('error', (error) => {
    if (error instanceof ApplicationError) {
        Logger.error(`Application error: ${error.message}`, error);
    } else {
        Logger.error('Unexpected error', error);
    }
    logMessage(`Error: ${error.message}`, 'system');
});

client.on('message', (message) => {
    if (message.error) {
        Logger.error('Server error:', message.error);
        logMessage(`Server error: ${message.error}`, 'system');
    }
});

sendButton.addEventListener('click', handleSendMessage);
messageInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        handleSendMessage();
    }
});

micButton.addEventListener('click', handleMicToggle);

connectButton.addEventListener('click', () => {
    if (isConnected) {
        disconnectFromWebsocket();
    } else {
        connectToWebsocket();
    }
});

messageInput.disabled = true;
sendButton.disabled = true;
micButton.disabled = true;
connectButton.textContent = 'Connect';

/**
 * Handles the video toggle. Starts or stops video streaming.
 * @returns {Promise<void>}
 */
async function handleVideoToggle() {
    Logger.info('Video toggle clicked, current state:', { isVideoActive, isConnected });
    
    localStorage.setItem('video_fps', fpsInput.value);

    if (!isVideoActive) {
        try {
            Logger.info('Attempting to start video');
            if (!videoManager) {
                videoManager = new VideoManager();
            }
            
            // videoManager.start 内部应该会设置 preview.srcObject
            await videoManager.start(fpsInput.value,(frameData, originalWidth, originalHeight) => {
                if (isConnected) {
                    client.sendRealtimeInput([frameData]);
                }
            });

            // 确保视频容器显示
            videoContainer.style.display = 'block';

            isVideoActive = true;
            cameraIcon.textContent = 'videocam_off';
            cameraButton.classList.add('active');
            Logger.info('Camera started successfully');
            logMessage('Camera started', 'system');

        } catch (error) {
            Logger.error('Camera error:', error);
            logMessage(`Error: ${error.message}`, 'system');
            isVideoActive = false;
            videoManager = null;
            cameraIcon.textContent = 'videocam';
            cameraButton.classList.remove('active');
            // 发生错误时也执行完整的停止逻辑，确保清除残留
            stopVideo(); 
        }
    } else {
        Logger.info('Stopping video');
        stopVideo();
    }
}

/**
 * Stops the video streaming.
 */
function stopVideo() {
    Logger.info('Attempting to stop video and clear display.');
    if (preview) {
        preview.pause(); // 暂停视频播放
        Logger.info('Video element paused.');

        if (preview.srcObject) {
            // 获取并停止所有 MediaStreamTrack
            const tracks = preview.srcObject.getTracks();
            tracks.forEach(track => {
                track.stop(); // 停止轨道
                Logger.info(`Track stopped: ${track.kind} - ${track.label}`);
            });
            preview.srcObject = null; // 清除 srcObject
            Logger.info('srcObject set to null.');
        } else {
            Logger.info('No active srcObject found on preview element.');
        }
        
        // **关键修复：强制视频元素重置以清除残留画面**
        // 1. 设置一个空字符串作为 src
        preview.src = ''; 
        // 2. 强制加载这个空 src，这会清空内部缓冲区
        preview.load();   
        Logger.info('Video element src set to empty and loaded for clearing.');

    } else {
        Logger.info('Preview element not found.');
    }

    if (videoManager) {
        videoManager.stop(); // 调用 videoManager 的 stop 方法 (可能重复但安全)
        videoManager = null;
        Logger.info('VideoManager stopped.');
    }
    
    // 隐藏容器
    videoContainer.style.display = 'none';
    Logger.info('Video container hidden.');

    isVideoActive = false;
    cameraIcon.textContent = 'videocam';
    cameraButton.classList.remove('active');
    logMessage('Camera stopped', 'system');
}

cameraButton.addEventListener('click', handleVideoToggle);
stopVideoButton.addEventListener('click', stopVideo);

cameraButton.disabled = true;

/**
 * Handles the screen share toggle. Starts or stops screen sharing.
 * @returns {Promise<void>}
 */
async function handleScreenShare() {
    if (!isScreenSharing) {
        try {
            screenContainer.style.display = 'block';
            
            screenRecorder = new ScreenRecorder();
            // screenRecorder.start 内部应该会设置 screenPreview.srcObject
            await screenRecorder.start(screenPreview, (frameData) => {
                if (isConnected) {
                    client.sendRealtimeInput([{
                        mimeType: "image/jpeg",
                        data: frameData
                    }]);
                }
            });

            isScreenSharing = true;
            screenIcon.textContent = 'stop_screen_share';
            screenButton.classList.add('active');
            Logger.info('Screen sharing started');
            logMessage('Screen sharing started', 'system');

        } catch (error) {
            Logger.error('Screen sharing error:', error);
            logMessage(`Error: ${error.message}`, 'system');
            isScreenSharing = false;
            screenIcon.textContent = 'screen_share';
            screenButton.classList.remove('active');
            // 发生错误时也执行完整的停止逻辑，确保清除残留
            stopScreenSharing();
        }
    } else {
        stopScreenSharing();
    }
}

/**
 * Stops the screen sharing.
 */
function stopScreenSharing() {
    Logger.info('Attempting to stop screen sharing and clear display.');
    if (screenPreview) {
        screenPreview.pause(); // 暂停视频播放
        Logger.info('Screen preview element paused.');

        if (screenPreview.srcObject) {
            // 获取并停止所有 MediaStreamTrack
            const tracks = screenPreview.srcObject.getTracks();
            tracks.forEach(track => {
                track.stop(); // 停止轨道
                Logger.info(`Screen track stopped: ${track.kind} - ${track.label}`);
            });
            screenPreview.srcObject = null; // 清除 srcObject
            Logger.info('Screen srcObject set to null.');
        } else {
            Logger.info('No active srcObject found on screenPreview element.');
        }
        
        // **关键修复：强制视频元素重置以清除残留画面**
        // 1. 设置一个空字符串作为 src
        screenPreview.src = ''; 
        // 2. 强制加载这个空 src，这会清空内部缓冲区
        screenPreview.load();   
        Logger.info('Screen preview element src set to empty and loaded for clearing.');

    } else {
        Logger.info('Screen preview element not found.');
    }

    if (screenRecorder) {
        screenRecorder.stop(); // 调用 screenRecorder 的 stop 方法
        screenRecorder = null;
        Logger.info('ScreenRecorder stopped.');
    }
    
    screenContainer.style.display = 'none';
    Logger.info('Screen container hidden.');

    isScreenSharing = false;
    screenIcon.textContent = 'screen_share';
    screenButton.classList.remove('active');
    logMessage('Screen sharing stopped', 'system');
}

screenButton.addEventListener('click', handleScreenShare);
screenButton.disabled = true;


// --- Draggable and Resizable Logic ---
let activeZIndex = 1000; // Base z-index for fixed elements

/**
 * Makes an HTML element draggable and resizable.
 * @param {HTMLElement} element - The element to make draggable/resizable.
 * @param {HTMLElement} [videoElement] - Optional: The inner video element to ensure it fills the container.
 * @param {number} [minWidth=200] - Minimum width for resizing.
 * @param {number} [minHeight=150] - Minimum height for resizing.
 */
function makeDraggableAndResizable(element, videoElement, minWidth = 200, minHeight = 150) {
    let isDragging = false;
    let isResizing = false;
    let currentHandle = null;
    let initialX, initialY, initialWidth, initialHeight, initialLeft, initialTop;

    const handles = element.querySelectorAll('.resize-handle');

    // Make draggable - listen on the element itself (excluding handles)
    element.addEventListener('mousedown', dragStart);
    element.addEventListener('touchstart', dragStart, { passive: false });

    // Make resizable - listen on the handles
    handles.forEach(handle => {
        handle.addEventListener('mousedown', resizeStart);
        handle.addEventListener('touchstart', resizeStart, { passive: false });
    });

    // Bring element to front on any interaction (click, drag, resize)
    element.addEventListener('mousedown', bringToFront);
    element.addEventListener('touchstart', bringToFront, { passive: false });

    function getEventCoords(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    function bringToFront() {
        // Increment z-index for the active element
        element.style.zIndex = ++activeZIndex;
    }

    function dragStart(e) {
        // If clicking on a resize handle, don't start dragging
        if (e.target.classList.contains('resize-handle')) {
            return;
        }

        e.preventDefault(); // Prevent default browser drag behavior (e.g., image drag)
        isDragging = true;
        element.classList.add('dragging');

        const coords = getEventCoords(e);
        initialX = coords.x;
        initialY = coords.y;
        initialLeft = element.offsetLeft;
        initialTop = element.offsetTop;

        // Add listeners to document to capture events even if mouse leaves the element
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', dragEnd);
    }

    function drag(e) {
        if (!isDragging) return;
        e.preventDefault();

        const coords = getEventCoords(e);
        const dx = coords.x - initialX;
        const dy = coords.y - initialY;

        // Calculate new position, clamping to viewport boundaries
        const newLeft = Math.max(0, Math.min(window.innerWidth - element.offsetWidth, initialLeft + dx));
        const newTop = Math.max(0, Math.min(window.innerHeight - element.offsetHeight, initialTop + dy));

        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;
    }

    function dragEnd() {
        isDragging = false;
        element.classList.remove('dragging');
        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', dragEnd);
        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', dragEnd);
    }

    function resizeStart(e) {
        e.preventDefault(); // Prevent default browser drag behavior (e.g., text selection)
        isResizing = true;
        currentHandle = e.target;
        element.classList.add('resizing');

        const coords = getEventCoords(e);
        initialX = coords.x;
        initialY = coords.y;
        initialWidth = element.offsetWidth;
        initialHeight = element.offsetHeight;
        initialLeft = element.offsetLeft;
        initialTop = element.offsetTop;

        document.addEventListener('mousemove', resize);
        document.addEventListener('mouseup', resizeEnd);
        document.addEventListener('touchmove', resize, { passive: false });
        document.addEventListener('touchend', resizeEnd);
    }

    function resize(e) {
        if (!isResizing) return;
        e.preventDefault();

        const coords = getEventCoords(e);
        const dx = coords.x - initialX;
        const dy = coords.y - initialY;

        let newWidth = initialWidth;
        let newHeight = initialHeight;
        let newLeft = initialLeft;
        let newTop = initialTop;

        const handleClass = currentHandle.classList;

        if (handleClass.contains('bottom-right')) {
            newWidth = Math.max(minWidth, initialWidth + dx);
            newHeight = Math.max(minHeight, initialHeight + dy);
        } else if (handleClass.contains('bottom-left')) {
            newWidth = Math.max(minWidth, initialWidth - dx);
            newHeight = Math.max(minHeight, initialHeight + dy);
            newLeft = initialLeft + dx;
        } else if (handleClass.contains('top-right')) {
            newWidth = Math.max(minWidth, initialWidth + dx);
            newHeight = Math.max(minHeight, initialHeight - dy);
            newTop = initialTop + dy;
        } else if (handleClass.contains('top-left')) {
            newWidth = Math.max(minWidth, initialWidth - dx);
            newHeight = Math.max(minHeight, initialHeight - dy);
            newLeft = initialLeft + dx;
            newTop = initialTop + dy;
        } else if (handleClass.contains('left')) {
            newWidth = Math.max(minWidth, initialWidth - dx);
            newLeft = initialLeft + dx;
        } else if (handleClass.contains('right')) {
            newWidth = Math.max(minWidth, initialWidth + dx);
        } else if (handleClass.contains('top')) {
            newHeight = Math.max(minHeight, initialHeight - dy);
            newTop = initialTop + dy;
        } else if (handleClass.contains('bottom')) {
            newHeight = Math.max(minHeight, initialHeight + dy);
        }

        // Apply new dimensions and position, clamping to viewport
        element.style.width = `${Math.min(window.innerWidth - newLeft, newWidth)}px`;
        element.style.height = `${Math.min(window.innerHeight - newTop, newHeight)}px`;
        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;

        // The video element inside will adjust automatically due to CSS (width: 100%; height: 100%; object-fit: contain;)
    }

    function resizeEnd() {
        isResizing = false;
        currentHandle = null;
        element.classList.remove('resizing');
        document.removeEventListener('mousemove', resize);
        document.removeEventListener('mouseup', resizeEnd);
        document.removeEventListener('touchmove', resize);
        document.removeEventListener('touchend', resizeEnd);
    }
}

// Apply draggable and resizable to video and screen containers
makeDraggableAndResizable(videoContainer, preview);
makeDraggableAndResizable(screenContainer, screenPreview);
