import React, { useState, useRef, useCallback, useEffect } from 'react';

// Get API base URL from window or default to localhost for development
const API_BASE = window.__API_BASE__ || 'http://localhost:3000';

// ---- TTS Cache with LRU Eviction (10 messages max) ----
class TTSCache {
  constructor(maxSize = 10) {
    this.cache = new Map(); // messageId -> { blob, url }
    this.maxSize = maxSize;
  }

  get(messageId) {
    if (this.cache.has(messageId)) {
      const entry = this.cache.get(messageId);
      // Move to end (most recently used)
      this.cache.delete(messageId);
      this.cache.set(messageId, entry);
      console.log('🎵 Cache HIT:', messageId);
      return entry;
    }
    console.log('🎵 Cache MISS:', messageId);
    return null;
  }

  set(messageId, blob) {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldEntry = this.cache.get(oldestKey);
      if (oldEntry && oldEntry.url) {
        console.log('🗑️ Evicting oldest cache entry:', oldestKey);
        URL.revokeObjectURL(oldEntry.url);
      }
      this.cache.delete(oldestKey);
    }
    
    const url = URL.createObjectURL(blob);
    this.cache.set(messageId, { blob, url });
    console.log('💾 Cached TTS:', messageId, '| Cache size:', this.cache.size);
  }

  clear() {
    this.cache.forEach((entry, key) => {
      if (entry.url) {
        URL.revokeObjectURL(entry.url);
      }
    });
    this.cache.clear();
    console.log('🗑️ Cache cleared');
  }
}

const ttsCache = new TTSCache(10);

// ---- TTS Manager with iOS Autoplay Support ----
class TTSManager {
  constructor() {
    this.audio = null;
    this.primed = false;
    this.playingId = null;
    this.queue = [];
    this.processing = false;
  }

  ensureAudioEl() {
    if (this.audio) return;
    console.log('🎵 Creating audio element');
    this.audio = document.createElement('audio');
    this.audio.setAttribute('playsinline', '');
    this.audio.preload = 'auto';
    document.body.appendChild(this.audio);
  }

  // Check if audio is currently playing
  isPlaying() {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  // Call during user gesture to unlock autoplay
  async prime() {
    this.ensureAudioEl();
    
    // Already primed or currently priming
    if (this.primed || this._priming) {
      console.log('✅ Audio already primed or priming in progress');
      return;
    }

    // ✅ Do NOT prime if we're in the middle of playing or processing
    if (this.isPlaying() || this.processing || (this.queue && this.queue.length > 0)) {
      console.log('⏭️ Skipping prime - audio already active');
      return;
    }

    this._priming = true;
    try {
      console.log('🔓 Priming audio element...');
      // 50ms silent MP3 data URI
      this.audio.src = 'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////////////////////////////////////////////8AAAA8TEFNRTMuMTAwA8MAAAAAAAAAABSAJAMGQgAAgAAAgnEWjwvdAAAAAAAAAAAAAAAAAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
      await this.audio.play();
      this.audio.pause();
      this.audio.currentTime = 0;
      this.primed = true;
      console.log('✅ Audio primed successfully');
    } catch (e) {
      console.warn('⚠️ Audio priming failed:', e.message);
      this.primed = false;
    } finally {
      this._priming = false;
    }
  }

  // Enqueue TTS blob for playback (with cache integration)
  enqueueBlob(id, blob, fromCache = false) {
    console.log('➕ Enqueueing blob for:', id, fromCache ? '(cached)' : '(new)');
    const url = URL.createObjectURL(blob);
    this.queue.push({ 
      id, 
      url, 
      revoke: () => {
        // Only revoke if NOT from cache (cache manages its own URLs)
        if (!fromCache) {
          console.log('🗑️ Revoking URL for:', id);
          URL.revokeObjectURL(url);
        } else {
          console.log('⏭️ Skipping revoke for cached:', id);
        }
      }
    });
    this._process();
  }

  // Stop if same message is playing
  stopIfPlaying(id) {
    if (this.playingId && this.playingId === id && this.audio) {
      console.log('🛑 Stopping currently playing message:', id);
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
      } catch (e) {
        console.error('Error pausing audio:', e);
      }
      this.playingId = null;
      return true;
    }
    return false;
  }

  async _process() {
    if (this.processing || !this.queue.length) {
      if (this.processing) console.log('⏸️ Queue already processing');
      return;
    }

    this.processing = true;
    console.log('🔄 Starting queue processing, items:', this.queue.length);

    while (this.queue.length > 0) {
      const { id, url, revoke } = this.queue.shift();
      this.playingId = id;
      console.log('🔊 Playing:', id, '| Remaining:', this.queue.length);

      try {
        this.audio.src = url;
        await this.audio.play();
        
        // Wait for audio to finish
        await new Promise((resolve) => {
          const onEnd = () => {
            console.log('✅ Audio ended:', id);
            cleanup();
            resolve();
          };
          const onErr = (e) => {
            console.error('❌ Audio error:', id, e);
            cleanup();
            resolve();
          };
          const cleanup = () => {
            this.audio.removeEventListener('ended', onEnd);
            this.audio.removeEventListener('error', onErr);
            revoke();
          };
          this.audio.addEventListener('ended', onEnd, { once: true });
          this.audio.addEventListener('error', onErr, { once: true });
        });
      } catch (e) {
        console.error('❌ Playback error for', id, ':', e);
        revoke();
      } finally {
        this.playingId = null;
      }

      // Small pause between messages
      if (this.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    this.processing = false;
    console.log('✅ Queue processing complete');
  }
}

const ttsManager = new TTSManager();

// Detect iOS for better defaults
const isiOS = typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent);

// UI Components  
function MessageBubble({ text, isUser, label, onSpeak, messageId, translation, hasBeenClicked }) {
  if (!text) return null;
  
  const bubbleStyle = isUser 
    ? {
        backgroundColor: '#3b82f6',
        color: 'white',
        borderRadius: '24px 24px 8px 24px',
        marginLeft: 'auto',
        marginRight: '8px',
      }
    : {
        backgroundColor: '#f3f4f6',
        color: '#1f2937',
        borderRadius: '24px 24px 24px 8px',
        marginLeft: '8px',
        marginRight: 'auto',
      };
  
  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: '16px',
      padding: '0 16px'
    }}>
      <div style={{ maxWidth: '75%' }}>
        {label && !isUser && (
          <div style={{
            fontSize: '12px',
            color: '#6b7280',
            marginBottom: '8px',
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            paddingLeft: '12px',
            userSelect: 'text'
          }}>
            {label}
          </div>
        )}
        <div
          onClick={(e) => onSpeak(text, messageId, e)}
          title="Click anywhere on this bubble to hear it spoken aloud and see English translation"
          style={{
            ...bubbleStyle,
            padding: '16px 20px',
            cursor: 'pointer',
            userSelect: 'text',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            transition: 'all 0.2s ease',
            fontWeight: '500',
            lineHeight: '1.5'
          }}
          className={isUser ? 'user-bubble' : 'assistant-bubble'}
        >
          <div style={{ 
            whiteSpace: 'pre-wrap',
            userSelect: 'text',
            fontSize: '16px'
          }}>
            {text}
          </div>
          {translation && hasBeenClicked && (
            <div style={{
              marginTop: '12px',
              paddingTop: '10px',
              borderTop: isUser 
                ? '1px solid rgba(255, 255, 255, 0.3)' 
                : '1px solid rgba(0, 0, 0, 0.1)',
              fontSize: '14px',
              fontStyle: 'italic',
              opacity: isUser ? '0.9' : '0.7',
              color: isUser ? 'rgba(255, 255, 255, 0.9)' : '#6b7280',
              backgroundColor: isUser 
                ? 'rgba(255, 255, 255, 0.1)' 
                : 'rgba(0, 0, 0, 0.02)',
              borderRadius: '6px',
              padding: '6px 8px',
              lineHeight: '1.4'
            }}>
              💬 {translation}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  // Initialize with a structured greeting using new simplified format
  const [messages, setMessages] = useState([
    { 
      role: "assistant", 
      correction_es: null,
      reply_es: "¡Hola! 😊 Soy tu tutor de español. Dime tu nombre y cómo te sientes hoy.", 
      needs_correction: false 
    }
  ]);
  

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showEnglish, setShowEnglish] = useState(false);
  const [error, setError] = useState('');
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false); // New state for permission flow
  const [translations, setTranslations] = useState(new Map()); // Track translations for messages
  const [clickedBubbles, setClickedBubbles] = useState(new Set()); // Track which bubbles have been clicked

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingStreamRef = useRef(null); // ✅ RENAMED: Dedicated ref for recording stream
  const permissionTestStreamRef = useRef(null); // ✅ Separate ref for permission test stream
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null); // For canceling requests
  const recordingStartTimeRef = useRef(null); // Track recording duration
  const isButtonPressedRef = useRef(false); // Track button press state
  const micPermissionGrantedRef = useRef(false); // Track mic permission to avoid stale closure
  const [showFirstRunScreen, setShowFirstRunScreen] = useState(false); // iOS first-run screen

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // PWA Install Prompt
  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallPrompt(true);
    };

    const handleAppInstalled = () => {
      console.log('PWA was installed');
      setShowInstallPrompt(false);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  // Check for iOS first-run screen
  useEffect(() => {
    if (isiOS) {
      const hasSeenFirstRun = localStorage.getItem('hasSeenFirstRunScreen');
      if (!hasSeenFirstRun) {
        console.log('📱 iOS first run - showing Enable Audio screen');
        setShowFirstRunScreen(true);
      }
    }
  }, []);

  // Check and store microphone permission status
  useEffect(() => {
    const checkPermission = async () => {
      try {
        // Check if permission was already granted before
        const storedPermission = localStorage.getItem('micPermissionGranted');
        if (storedPermission === 'true') {
          setMicPermissionGranted(true);
          micPermissionGrantedRef.current = true;
          console.log('Microphone permission already granted (from storage)');
          return;
        }

        // Try to check current permission status
        if (navigator.permissions) {
          const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
          if (permissionStatus.state === 'granted') {
            setMicPermissionGranted(true);
            micPermissionGrantedRef.current = true;
            localStorage.setItem('micPermissionGranted', 'true');
            console.log('Microphone permission already granted (from browser)');
          }
        }
      } catch (err) {
        console.log('Could not check microphone permission status:', err);
      }
    };

    checkPermission();

    // Cleanup on unmount
    return () => {
      console.log('Cleaning up audio resources on unmount');
      if (recordingStreamRef.current) {
        recordingStreamRef.current.getTracks().forEach(track => {
          track.stop();
          console.log('Cleanup: stopped track', track.id);
        });
        recordingStreamRef.current = null;
      }
      if (mediaRecorderRef.current) {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current = null;
      }
      // Clear TTS cache
      ttsCache.clear();
    };
  }, []);

  const handleInstallClick = () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('User accepted the install prompt');
        }
        setDeferredPrompt(null);
        setShowInstallPrompt(false);
      });
    }
  };

  // Cancel processing function
  const cancelProcessing = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsProcessing(false);
    setError('Request cancelled');
    console.log('Processing cancelled by user');
  }, []);

  const requestMicPermissionOnce = useCallback(async () => {
    if (permissionRequested || isRequestingPermission) return;
    
    try {
      setIsRequestingPermission(true);
      setPermissionRequested(true);
      console.log('Requesting microphone permission...');
      
      // Enhanced audio constraints for better mobile compatibility
      const constraints = {
        audio: {
          sampleRate: { ideal: 16000, min: 8000, max: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // iOS-specific optimizations
          ...(isiOS && {
            sampleSize: 16,
            volume: 1.0
          })
        }
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Store in SEPARATE ref to avoid conflicts with recording stream
      permissionTestStreamRef.current = stream;
      
      // Store permission in localStorage
      localStorage.setItem('micPermissionGranted', 'true');
      setMicPermissionGranted(true);
      micPermissionGrantedRef.current = true;
      console.log('✅ Microphone permission granted and stored');
      
      // Clean up test stream after longer delay for iOS stability
      setTimeout(() => {
        if (permissionTestStreamRef.current) {
          permissionTestStreamRef.current.getTracks().forEach(track => {
            track.stop();
            console.log('Stopped permission test track:', track.id);
          });
          permissionTestStreamRef.current = null;
        }
      }, 5000); // ✅ Extended to 5s for iOS
      
    } catch (err) {
      console.error('Microphone permission denied:', err);
      setError('Microphone permission denied. Please enable it in your browser settings.');
      setPermissionRequested(false);
    } finally {
      setIsRequestingPermission(false);
    }
  }, [permissionRequested, isRequestingPermission]);

  // Define startRecording BEFORE handleButtonPress so it can be used in dependencies
  const startRecording = useCallback(async (e) => {
    console.log('🎤 startRecording called');
    
    // Prevent default behavior and stop event propagation
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    console.log('🎤 Current state check:', {
      isRecording,
      isProcessing,
      isRequestingPermission,
      micPermissionGranted
    });

    // Prevent starting if already recording, processing, or requesting permission
    if (isRecording || isProcessing || isRequestingPermission) {
      console.log('🎤 Already recording, processing, or requesting permission - ignoring start request');
      return;
    }

    // Must have permission to record
    if (!micPermissionGranted) {
      console.log('🎤 No microphone permission - cannot start recording');
      return;
    }

    // Set recording state IMMEDIATELY for instant visual feedback
    setIsRecording(true);

    console.log('Starting recording with existing permission...');
    
    try {
      setError('');

      // Request a fresh stream for this recording session with mobile-compatible constraints
      const constraints = {
        audio: {
          sampleRate: { ideal: 16000, min: 8000, max: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // iOS-specific optimizations
          ...(isiOS && {
            sampleSize: 16,
            volume: 1.0
          })
        }
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      recordingStreamRef.current = stream; // ✅ Use dedicated recording ref
      audioChunksRef.current = [];

      // Force MP4 for iOS (best compatibility with OpenAI Whisper)
      // For other platforms, try compatible formats
      let mimeType = '';
      if (isiOS) {
        // iOS Safari only supports MP4
        mimeType = 'audio/mp4';
        console.log('iOS detected - using audio/mp4');
      } else {
        // Try formats in order of Whisper compatibility
        const mimeTypesToTry = [
          'audio/mp4',
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg'
        ];
        
        for (const type of mimeTypesToTry) {
          if (MediaRecorder.isTypeSupported(type)) {
            mimeType = type;
            console.log('Selected MIME type:', mimeType);
            break;
          }
        }
      }
      
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      console.log('MediaRecorder created with mimeType:', mediaRecorder.mimeType);

      mediaRecorder.ondataavailable = (event) => {
        console.log('Data available:', event.data.size, 'bytes');
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('MediaRecorder stopped, chunks collected:', audioChunksRef.current.length);
        
        // Process the audio if we have data
        if (audioChunksRef.current.length > 0) {
          // Use the actual MIME type from the recorder
          const blobType = mediaRecorder.mimeType || mimeType || 'audio/webm';
          console.log('Creating blob with type:', blobType);
          const audioBlob = new Blob(audioChunksRef.current, { type: blobType });
          console.log('Audio blob created:', audioBlob.size, 'bytes');
          
          // Clean up BEFORE processing to prevent interference
          if (recordingStreamRef.current) {
            recordingStreamRef.current.getTracks().forEach(track => {
              track.stop();
              console.log('Stopped recording track:', track.id, track.readyState);
            });
            recordingStreamRef.current = null;
          }
          mediaRecorderRef.current = null;
          
          await processAudio(audioBlob);
        } else {
          console.log('No audio data collected');
          setIsProcessing(false);
          setError('No audio recorded. Try speaking closer to the microphone.');
          
          // Clean up even if no data
          if (recordingStreamRef.current) {
            recordingStreamRef.current.getTracks().forEach(track => track.stop());
            recordingStreamRef.current = null;
          }
          mediaRecorderRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      
      // Reset audio chunks before starting
      audioChunksRef.current = [];
      
      // Start recording with data collection interval
      mediaRecorder.start(1000); // Collect data every second
      recordingStartTimeRef.current = Date.now(); // Track start time
      // Don't set isRecording again - already set for immediate feedback
      console.log('Recording started');
      
      // Additional logging for debugging
      console.log('MediaRecorder state:', mediaRecorder.state);
      console.log('Stream active:', stream.active);
      console.log('Stream tracks:', stream.getTracks().map(t => ({id: t.id, kind: t.kind, enabled: t.enabled, readyState: t.readyState})));
      
    } catch (err) {
      setError('Error starting recording: ' + err.message);
      setIsRecording(false);
      console.error('Recording error:', err);
    }
  }, [isRecording, isProcessing, micPermissionGranted, isRequestingPermission]);

  // Simple, direct button press handler - no complex dependencies
  const handleButtonPress = useCallback(async (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    
    console.log('🎯 Button pressed - Permission:', micPermissionGrantedRef.current);
    
    // Prime audio element during user gesture for iOS autoplay
    await ttsManager.prime();
    
    // Don't do anything if already busy
    if (isProcessing || isRequestingPermission || isRecording) {
      console.log('🎯 Busy - ignoring press');
      return;
    }

    // If no permission, request it and EXIT (don't record)
    if (!micPermissionGrantedRef.current) {
      console.log('🎯 Requesting permission...');
      requestMicPermissionOnce();
      return;
    }

    // Have permission - start recording immediately
    console.log('🎯 Starting recording NOW');
    startRecording(e);
  }, [isProcessing, isRequestingPermission, isRecording, requestMicPermissionOnce, startRecording]);

  // Simple, direct stop handler
  const stopRecording = useCallback((e) => {
    e?.preventDefault();
    e?.stopPropagation();

    console.log('🛑 Button released');
    
    // Don't stop if we're requesting permission
    if (isRequestingPermission) {
      console.log('🛑 Requesting permission - ignoring release');
      return;
    }
    
    // Don't stop if not recording
    if (!isRecording) {
      console.log('🛑 Not recording - ignoring release');
      return;
    }

    // Check minimum recording duration (800ms minimum for valid audio)
    const recordingDuration = Date.now() - (recordingStartTimeRef.current || 0);
    if (recordingDuration < 800) {
      console.log('⚠️ Recording too short:', recordingDuration + 'ms - ignoring');
      setIsRecording(false);
      // Stop and clean up
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (recordingStreamRef.current) {
        recordingStreamRef.current.getTracks().forEach(track => track.stop());
        recordingStreamRef.current = null;
      }
      return;
    }

    console.log('🛑 Stopping recording NOW (duration:', recordingDuration + 'ms)');
    setIsRecording(false);
    
    // Stop MediaRecorder
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    
    // Force stop all tracks immediately
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('🛑 Track stopped:', track.id);
      });
    }
  }, [isRecording, isRequestingPermission]);

  const processAudio = useCallback(async (audioBlob) => {
    setIsProcessing(true);
    setError(''); // Clear any previous errors
    
    console.log('Processing audio blob:', {
      size: audioBlob.size,
      type: audioBlob.type
    });
    
    // Create abort controller for this request
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    
    try {
      // Send to speech-to-text
      const formData = new FormData();
      
      // Determine filename based on MIME type for OpenAI compatibility
      let filename = 'audio.mp4'; // Default for iOS
      if (audioBlob.type.includes('webm')) {
        filename = 'audio.webm';
      } else if (audioBlob.type.includes('ogg')) {
        filename = 'audio.ogg';
      } else if (audioBlob.type.includes('wav')) {
        filename = 'audio.wav';
      }
      
      formData.append('audio', audioBlob, filename);
      console.log('Sending audio as:', filename, 'type:', audioBlob.type);

      console.log('Sending STT request to:', `${API_BASE}/stt`);
      const sttResponse = await fetch(`${API_BASE}/stt`, {
        method: 'POST',
        body: formData,
        signal // Add abort signal
      });

      if (signal.aborted) return; // Check if cancelled

      console.log('STT response status:', sttResponse.status);

      if (!sttResponse.ok) {
        const errorText = await sttResponse.text();
        console.error('STT error response:', errorText);
        throw new Error(`STT failed: ${sttResponse.status} - ${errorText}`);
      }

      const sttData = await sttResponse.json();
      console.log('STT response data:', sttData);
      const userText = sttData.text || '';
      console.log('Extracted user text:', userText);

      // Filter out known Whisper artifacts and spurious responses
      const isSpuriousResponse = (text) => {
        const lowerText = text.toLowerCase().trim();
        const spuriousPatterns = [
          // Amara.org subtitle artifacts
          'subtítulos realizados por la comunidad de amara.org',
          'subtitulos realizados por la comunidad de amara.org',
          'subtitles made by the amara.org community',
          'subtitles by amara.org',
          // Other common Whisper artifacts
          'thank you for watching',
          'thanks for watching',
          'transcribed by',
          'captioned by',
          'www.amara.org',
          'amara.org',
          // Very short meaningless responses
          '.',
          ',',
          '?',
          '!',
          'um',
          'uh',
          'mm',
          'hmm'
        ];
        
        // Check if text matches any spurious patterns
        // For punctuation-only patterns, use exact match; for others use includes
        const punctuationOnly = ['.', ',', '?', '!'];
        return spuriousPatterns.some(pattern => {
          if (punctuationOnly.includes(pattern)) {
            return lowerText === pattern; // Exact match for punctuation
          } else {
            return lowerText.includes(pattern); // Includes match for phrases
          }
        }) || lowerText.length < 2; // Also filter very short responses
      };

      const isSpurious = isSpuriousResponse(userText);
      console.log('Text filtering check:', {
        text: userText,
        trimmed: userText.trim(),
        isEmpty: !userText.trim(),
        isSpurious: isSpurious,
        willBeFiltered: !userText.trim() || isSpurious
      });

      if (!userText.trim() || isSpurious) {
        console.log('Text filtered out as spurious or empty');
        setError('No speech detected. Try speaking louder or closer to the microphone.');
        return;
      }

      console.log('Text passed filtering, processing message...');

      // Add user message
      const newUserMessage = { role: 'user', text: userText };
      setMessages(prev => [...prev, newUserMessage]);

      // Convert to simple format for backend
      const simpleHistory = [...messages, { role: 'user', content: userText }].map(msg => ({
        role: msg.role,
        content: msg.text || msg.content || [msg.correction_es, msg.reply_es].filter(Boolean).join(' ')
      }));

      if (signal.aborted) return; // Check if cancelled before chat request

      // Send to chat with translation flag (always request translations for pre-caching)
      const chatResponse = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: simpleHistory, 
          translate: true // Always request translations for pre-caching
        }),
        signal // Add abort signal
      });

      if (signal.aborted) return; // Check if cancelled

      if (!chatResponse.ok) {
        throw new Error(`Chat failed: ${chatResponse.status}`);
      }

      const data = await chatResponse.json();
      
      // Add structured assistant response with new simplified format
      // Filter out string "null" values from OpenAI
      const assistantMessage = {
        role: 'assistant',
        correction_es: (data.correction_es && data.correction_es !== 'null') ? data.correction_es : null,
        reply_es: data.reply_es || '',
        translation_en: data.translation_en,
        needs_correction: !!data.needs_correction
      };

      // Will calculate correct index inside setMessages callback
      let actualAssistantIndex = -1;
      
      // Pre-cache translations for instant display when bubbles are clicked
      setMessages(prev => {
        const newMessages = [...prev, assistantMessage];
        const actualIndex = newMessages.length - 1;
        actualAssistantIndex = actualIndex; // Capture for auto-play
        const userIndex = actualIndex - 1;
        console.log('📍 Assistant message added at index:', actualIndex);
        
        // Pre-translate and cache user message
        if (userIndex >= 0 && newMessages[userIndex].role === 'user') {
          const userMessageId = `user-${userIndex}`;
          const userText = newMessages[userIndex].text;
          translateText(userText).then(translation => {
            if (translation) {
              setTranslations(prev => new Map(prev.set(userMessageId, translation)));
            }
          });
        }
        
        // Pre-cache assistant translations if available
        if (data.translation_en) {
          const newTranslations = new Map();
          // Helper function to extract text from brackets
          const extractFromBrackets = (text) => {
            const match = text.match(/\[(.*?)\]/);
            return match ? match[1] : text.trim();
          };
          
          if (data.correction_es && data.translation_en.includes('correction:')) {
            const correctionLine = data.translation_en.split('correction:')[1]?.split('\n')[0]?.trim();
            if (correctionLine) {
              const correctionTranslation = extractFromBrackets(correctionLine);
              newTranslations.set(`assistant-${actualIndex}-correction`, correctionTranslation);
            }
          }
          if (data.reply_es && data.translation_en.includes('reply:')) {
            const replyLine = data.translation_en.split('reply:')[1]?.trim();
            if (replyLine) {
              const replyTranslation = extractFromBrackets(replyLine);
              newTranslations.set(`assistant-${actualIndex}-reply`, replyTranslation);
            }
          }
          
          // Update translations state
          if (newTranslations.size > 0) {
            setTranslations(prev => {
              const updated = new Map(prev);
              newTranslations.forEach((value, key) => updated.set(key, value));
              return updated;
            });
          }
        }
        
        return newMessages;
      });

      // Auto-play AI response using primed audio element
      // Fetch TTS blobs and enqueue for playback
      const partsToPlay = [];
      // Only add correction if it exists AND is not the string "null"
      if (data.correction_es && data.correction_es !== 'null') {
        partsToPlay.push({ 
          text: data.correction_es, 
          messageId: `assistant-${actualAssistantIndex}-correction` 
        });
      }
      if (data.reply_es) {
        partsToPlay.push({ 
          text: data.reply_es, 
          messageId: `assistant-${actualAssistantIndex}-reply` 
        });
      }
      
      if (partsToPlay.length > 0) {
        console.log('🔊 Auto-playing AI response with IDs:', partsToPlay.map(p => p.messageId));
        console.log('🔊 Using assistant index:', actualAssistantIndex);
        
        // Fetch and cache new TTS (never check cache for new AI responses)
        for (const { text, messageId } of partsToPlay) {
          try {
            // Always fetch fresh TTS for new AI messages
            const response = await fetch(`${API_BASE}/tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text })
            });
            
            if (response.ok) {
              const blob = await response.blob();
              ttsCache.set(messageId, blob); // ✅ Cache for future bubble taps
              ttsManager.enqueueBlob(messageId, blob);
            } else {
              console.error('TTS fetch failed for', messageId, ':', response.status);
            }
          } catch (e) {
            console.error('Auto-play fetch error for', messageId, ':', e);
          }
        }
      }

    } catch (err) {
      console.error('Full processing error:', err);
      if (err.name === 'AbortError') {
        console.log('Request was cancelled');
        return; // Don't show error for cancelled requests
      }
      setError('Error processing audio: ' + err.message);
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null; // Clear the abort controller
    }
  }, [messages, showEnglish]);

  // Translation function
  const translateText = useCallback(async (text) => {
    try {
      console.log('🔄 Translating text:', text);
      const response = await fetch(`${API_BASE}/api/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          text: text,
          from: 'es',
          to: 'en'
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Translation received:', data.translation);
        return data.translation;
      } else {
        console.error('❌ Translation API error:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('❌ Translation fetch error:', error);
    }
    return null;
  }, []);

  // Speak function for bubble taps - uses primed audio element
  const speak = useCallback(async (text, messageId, event) => {
    // Prevent event bubbling to avoid conflicts
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    console.log('🔊 Speak requested:', { text: text.substring(0, 30), messageId });
    
    // Mark bubble as clicked to reveal translation
    if (messageId) {
      setClickedBubbles(prev => new Set(prev.add(messageId)));
    }
    
    // If same message is playing, stop it
    if (ttsManager.stopIfPlaying(messageId)) {
      console.log('🛑 Stopped currently playing message');
      return;
    }
    
    // Prime under this gesture if needed (safe - won't interrupt active playback)
    await ttsManager.prime();
    
    // Check cache first, then fetch if needed
    try {
      const cached = ttsCache.get(messageId);
      if (cached) {
        console.log('🎵 Bubble tap using cached TTS:', messageId);
        ttsManager.enqueueBlob(messageId, cached.blob, true);
      } else {
        // Fetch, cache, and play
        const response = await fetch(`${API_BASE}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        
        if (response.ok) {
          const blob = await response.blob();
          ttsCache.set(messageId, blob); // ✅ Cache for future taps
          ttsManager.enqueueBlob(messageId, blob);
        } else {
          console.error('TTS fetch failed:', response.status);
        }
      }
    } catch (err) {
      console.error('TTS fetch error:', err);
    }
    
    // Fetch translation if not cached (fallback)
    if (messageId && !translations.has(messageId)) {
      console.log('⚠️ Translation not cached - fetching');
      const translation = await translateText(text);
      if (translation) {
        setTranslations(prev => new Map(prev.set(messageId, translation)));
      }
    }
  }, [translations, translateText]);

  const clearConversation = useCallback(() => {
    setMessages([]);
    setError('');
    setTranslations(new Map()); // Clear all translations
    setClickedBubbles(new Set()); // Clear clicked bubbles state
    ttsCache.clear(); // ✅ Clear TTS cache
  }, []);

  // iOS first-run screen handler
  const handleEnableAudio = useCallback(async () => {
    console.log('📱 iOS first-run: Enabling audio...');
    // Prime audio element
    await ttsManager.prime();
    // Request mic permission
    await requestMicPermissionOnce();
    // Mark as seen
    localStorage.setItem('hasSeenFirstRunScreen', 'true');
    setShowFirstRunScreen(false);
    console.log('✅ iOS first-run complete');
  }, [requestMicPermissionOnce]);

  return (
    <div className="h-full w-full bg-gray-50 flex flex-col overflow-hidden" style={{ height: '100vh', width: '100vw' }}>
      {/* iOS First-Run Screen */}
      {showFirstRunScreen && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '32px'
          }}
        >
          <div style={{ textAlign: 'center', color: 'white' }}>
            <div style={{ fontSize: '64px', marginBottom: '24px' }}>🎙️</div>
            <h2 style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '16px' }}>
              Enable Audio
            </h2>
            <p style={{ fontSize: '16px', marginBottom: '32px', opacity: 0.9, maxWidth: '320px' }}>
              To use voice features, we need access to your microphone.
            </p>
            <button
              onClick={handleEnableAudio}
              style={{
                backgroundColor: '#3b82f6',
                color: 'white',
                fontSize: '18px',
                fontWeight: 'bold',
                padding: '16px 48px',
                borderRadius: '12px',
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(59, 130, 246, 0.5)'
              }}
            >
              Enable Audio & Microphone
            </button>
          </div>
        </div>
      )}
      
      {/* Header - Fixed Height */}
      <header className="bg-white shadow-sm border-b px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 
              className="text-xl font-semibold text-gray-800"
              style={{ 
                userSelect: 'text', 
                WebkitUserSelect: 'text',
                MozUserSelect: 'text',
                msUserSelect: 'text'
              }}
            >
              🇲🇽 Práctica de Español
            </h1>
          </div>
          <div className="flex items-center gap-4">
            {showInstallPrompt && (
              <button
                onClick={handleInstallClick}
                className="text-xs px-2 py-1 bg-blue-100 text-blue-600 rounded hover:bg-blue-200 transition-colors font-medium"
              >
                📱 Install App
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showEnglish}
                onChange={(e) => setShowEnglish(e.target.checked)}
                className="h-3 w-3 rounded"
              />
              <span>English</span>
            </label>
            <button
              onClick={clearConversation}
              className="text-xs px-2 py-1 bg-red-100 text-red-600 rounded hover:bg-red-200 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </header>

      {/* Chat Messages Container - Scrollable, Takes Remaining Space */}
      <div 
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          background: 'linear-gradient(to bottom, #eff6ff, #ffffff, #eff6ff)',
          padding: '24px 0'
        }}
      >
        <div style={{ maxWidth: '1024px', margin: '0 auto', height: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {messages.map((message, index) => {
              
              if (message.role === 'user') {
                const messageId = `user-${index}`;
                return (
                  <MessageBubble 
                    key={messageId} 
                    text={message.text} 
                    isUser={true}
                    onSpeak={speak}
                    messageId={messageId}
                    translation={translations.get(messageId)}
                    hasBeenClicked={clickedBubbles.has(messageId)} 
                  />
                );
              }

              return (
                <div key={`assistant-${index}`} className="space-y-2">
                  {/* Show correction first if it exists and is not string "null" */}
                  {message.correction_es && message.correction_es !== 'null' && (
                    <MessageBubble 
                      text={message.correction_es} 
                      isUser={false}
                      label="Corrección"
                      onSpeak={speak}
                      messageId={`assistant-${index}-correction`}
                      translation={translations.get(`assistant-${index}-correction`)}
                      hasBeenClicked={clickedBubbles.has(`assistant-${index}-correction`)} 
                    />
                  )}
                  {/* Main reply (always shown) */}
                  {message.reply_es && (
                    <MessageBubble 
                      text={message.reply_es} 
                      isUser={false}
                      onSpeak={speak}
                      messageId={`assistant-${index}-reply`}
                      translation={translations.get(`assistant-${index}-reply`)}
                      hasBeenClicked={clickedBubbles.has(`assistant-${index}-reply`)} 
                    />
                  )}
                  {message.question_es && (
                    <MessageBubble 
                      text={message.question_es} 
                      isUser={false}
                      onSpeak={speak}
                      messageId={`assistant-${index}-question`}
                      translation={translations.get(`assistant-${index}-question`)}
                      hasBeenClicked={clickedBubbles.has(`assistant-${index}-question`)} 
                    />
                  )}
                  {showEnglish && message.translation_en && (
                    <MessageBubble 
                      text={message.translation_en} 
                      isUser={false}
                      label="English"
                      onSpeak={async (text) => await speakServerTTS(text, API_BASE)} 
                    />
                  )}
                </div>
              );
            })}
          </div>
          {/* Invisible element to scroll to */}
          <div ref={messagesEndRef} className="h-4" />
        </div>
      </div>

      {/* Error Bar - Fixed Height (when visible) */}
      {error && (
        <div className="bg-white border-t px-4 py-2 shrink-0">
          <div className="max-w-4xl mx-auto">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        </div>
      )}

      {/* Bottom Microphone Button - Fixed Height */}
      <div className="bg-white border-t px-4 pt-12 pb-6 shrink-0">
        <div className="max-w-4xl mx-auto text-center">
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('👆 PointerDown event fired');
              // Add holding-mic class for pointer-events isolation
              document.body.classList.add('holding-mic');
              if (!isProcessing && !isRequestingPermission) {
                console.log('👆 PointerDown conditions met, calling handleButtonPress');
                handleButtonPress(e);
              } else {
                console.log('👆 PointerDown blocked:', { isProcessing, isRequestingPermission });
              }
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('👆 PointerUp event fired');
              // Remove holding-mic class
              document.body.classList.remove('holding-mic');
              if (!isRequestingPermission) {
                console.log('👆 PointerUp calling stopRecording');
                stopRecording(e);
              } else {
                console.log('👆 PointerUp blocked:', { isRequestingPermission });
              }
            }}
            onPointerCancel={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('👆 PointerCancel event fired');
              // Remove holding-mic class
              document.body.classList.remove('holding-mic');
              if (!isRequestingPermission) {
                stopRecording(e);
              }
            }}
            onClick={(e) => {
              if (isProcessing) {
                cancelProcessing();
              }
            }}
            className="rounded-full text-6xl transition-all duration-200 transform shadow-xl active:scale-95 text-white font-medium cursor-pointer"
            style={{
              width: '360px',
              height: '60px',
              minWidth: '360px',
              minHeight: '60px',
              marginTop: '10px',
              backgroundColor: isRequestingPermission 
                ? '#9ca3af' 
                : isProcessing 
                  ? '#ef4444' 
                  : '#3b82f6',
              border: 'none',
              outline: 'none',
              transform: isRecording ? 'scale(1.05)' : 'scale(1)',
              animation: isRecording ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none',
              boxShadow: isRecording 
                ? '0 8px 20px rgba(59, 130, 246, 0.5)' 
                : isProcessing
                  ? '0 8px 20px rgba(239, 68, 68, 0.3)'
                  : '0 4px 12px rgba(59, 130, 246, 0.3)',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
              opacity: isRequestingPermission ? 0.6 : 1
            }}
          >
            <span style={{ userSelect: 'none', WebkitUserSelect: 'none', pointerEvents: 'none' }}>
              {isRequestingPermission ? '🔐' : isProcessing ? '✖️' : isRecording ? '⏹️' : '🎙️'}
            </span>
          </button>
          
          <p 
            className="mt-2 text-sm text-gray-600"
            style={{ 
              userSelect: 'text', 
              WebkitUserSelect: 'text',
              MozUserSelect: 'text',
              msUserSelect: 'text'
            }}
          >
            {isRequestingPermission
              ? 'Requesting microphone permission...'
              : isProcessing 
                ? 'Processing... (click to cancel)' 
                : isRecording 
                  ? 'Recording... (release to send)'
                  : micPermissionGranted 
                    ? 'Hold to speak'
                    : 'Press to request microphone access'
            }
            <br />
            <small style={{ fontSize: '10px', opacity: 0.7 }}>
              Debug: perm={micPermissionGranted.toString()} | rec={isRecording.toString()} | proc={isProcessing.toString()} | req={isRequestingPermission.toString()}
            </small>
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
