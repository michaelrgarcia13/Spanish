import React, { useState, useRef, useCallback, useEffect } from 'react';
import eruda from 'eruda';

// Initialize Eruda console for mobile debugging
if (typeof window !== 'undefined') {
  eruda.init();
  
  // Add custom "Copy All Logs" button to Eruda after it loads
  setTimeout(() => {
    try {
      const consoleTool = eruda.get('console');
      if (consoleTool) {
        // Override the console to capture all logs
        const allLogs = [];
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        
        console.log = function(...args) {
          allLogs.push(['LOG', ...args]);
          originalLog.apply(console, args);
        };
        console.error = function(...args) {
          allLogs.push(['ERROR', ...args]);
          originalError.apply(console, args);
        };
        console.warn = function(...args) {
          allLogs.push(['WARN', ...args]);
          originalWarn.apply(console, args);
        };
        
        // Add copy button to Eruda toolbar
        window.copyAllLogs = () => {
          const logText = allLogs.map(log => {
            const [type, ...messages] = log;
            const msgStr = messages.map(m => 
              typeof m === 'object' ? JSON.stringify(m, null, 2) : String(m)
            ).join(' ');
            return `${type}: ${msgStr}`;
          }).join('\n');
          
          navigator.clipboard.writeText(logText).then(() => {
            originalLog('✅ Copied all logs to clipboard!');
          }).catch(err => {
            originalError('Failed to copy logs:', err);
            // Fallback: create temporary textarea
            const textarea = document.createElement('textarea');
            textarea.value = logText;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            originalLog('✅ Copied all logs using fallback method!');
          });
        };
        
        originalLog('📋 Type copyAllLogs() in console or use Ctrl+Shift+C to copy all logs');
      }
    } catch (e) {
      console.error('Failed to setup Eruda copy helper:', e);
    }
  }, 1000);
}

// Get API base URL from window or default to localhost for development
const API_BASE = window.__API_BASE__ || 'http://localhost:3000';

// ---- TTS Cache with LRU Eviction (20 messages max) ----
class TTSCache {
  constructor(maxSize = 20) {
    this.cache = new Map(); // messageId -> { blob, url }
    this.maxSize = maxSize;
    this.playingIds = new Set(); // Track currently playing IDs to prevent eviction
  }

  get(messageId) {
    if (this.cache.has(messageId)) {
      const entry = this.cache.get(messageId);
      // Move to end (most recently used)
      this.cache.delete(messageId);
      this.cache.set(messageId, entry);
      console.log('🎵 Cache HIT:', messageId);
      return entry.url; // ✅ Return URL directly, not blob
    }
    console.log('🎵 Cache MISS:', messageId);
    return null;
  }

  set(messageId, blob) {
    // Evict oldest if at capacity (skip if currently playing)
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      
      // Skip eviction if this audio is currently playing
      if (this.playingIds.has(oldestKey)) {
        console.log('⏭️ Skipping eviction of playing audio:', oldestKey);
        // Move to end to try next oldest
        const entry = this.cache.get(oldestKey);
        this.cache.delete(oldestKey);
        this.cache.set(oldestKey, entry);
        continue;
      }
      
      const oldEntry = this.cache.get(oldestKey);
      if (oldEntry && oldEntry.url) {
        console.log('🗑️ Evicting oldest cache entry:', oldestKey);
        URL.revokeObjectURL(oldEntry.url);
      }
      this.cache.delete(oldestKey);
      break;
    }
    
    const url = URL.createObjectURL(blob);
    this.cache.set(messageId, { blob, url });
    console.log('💾 Cached TTS:', messageId, '| Cache size:', this.cache.size);
  }

  markPlaying(messageId) {
    this.playingIds.add(messageId);
  }

  markStopped(messageId) {
    this.playingIds.delete(messageId);
  }

  clear() {
    this.cache.forEach((entry, key) => {
      if (entry.url) {
        URL.revokeObjectURL(entry.url);
      }
    });
    this.cache.clear();
    this.playingIds.clear();
    console.log('🗑️ Cache cleared');
  }
}

const ttsCache = new TTSCache(20);

// ---- TTS Manager - Simplified (no mic suspend/resume) ----
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

  isPlaying() {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  async prime() {
    this.ensureAudioEl();
    
    if (this.primed || this._priming) {
      console.log('✅ Audio already primed');
      return;
    }

    if (this.isPlaying() || this.processing || (this.queue && this.queue.length > 0)) {
      console.log('⏭️ Skipping prime - audio active');
      return;
    }

    this._priming = true;
    try {
      console.log('🔓 Priming audio...');
      this.audio.src = 'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////////////////////////////////////////////8AAAA8TEFNRTMuMTAwA8MAAAAAAAAAABSAJAMGQgAAgAAAgnEWjwvdAAAAAAAAAAAAAAAAAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
      await this.audio.play();
      this.audio.pause();
      this.audio.currentTime = 0;
      this.primed = true;
      console.log('✅ Audio primed');
    } catch (e) {
      console.warn('⚠️ Priming failed:', e.message);
      this.primed = false;
    } finally {
      this._priming = false;
    }
  }

  enqueueBlob(id, blobOrUrl, fromCache = false) {
    console.log('➕ Enqueue:', id, fromCache ? '(cached)' : '(new)');
    
    let url;
    if (fromCache) {
      url = blobOrUrl;
    } else {
      url = URL.createObjectURL(blobOrUrl);
    }
    
    this.queue.push({ 
      id, 
      url, 
      fromCache,
      revoke: () => {
        if (!fromCache) {
          URL.revokeObjectURL(url);
        }
      }
    });
    
    this._process();
  }

  stopIfPlaying(id) {
    if (this.playingId === id && this.isPlaying()) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.playingId = null;
      return true;
    }
    return false;
  }

  async _process() {
    if (this.processing || !this.queue.length) {
      if (this.processing) console.log('⏸️ Already processing');
      return;
    }

    this.processing = true;
    console.log('🔄 Processing queue, items:', this.queue.length);

    while (this.queue.length > 0) {
      const { id, url, revoke, fromCache } = this.queue.shift();
      this.playingId = id;
      
      if (fromCache) {
        ttsCache.markPlaying(id);
      }
      
      console.log('🔊 Playing:', id);

      try {
        this.audio.src = url;
        await this.audio.play();
        
        await new Promise((resolve) => {
          const onEnd = () => {
            console.log('✅ Ended:', id);
            cleanup();
            resolve();
          };
          const onErr = (e) => {
            console.error('❌ Error:', id, e);
            cleanup();
            resolve();
          };
          const cleanup = () => {
            this.audio.removeEventListener('ended', onEnd);
            this.audio.removeEventListener('error', onErr);
            revoke();
            if (fromCache) {
              ttsCache.markStopped(id);
            }
          };
          this.audio.addEventListener('ended', onEnd, { once: true });
          this.audio.addEventListener('error', onErr, { once: true });
        });
      } catch (e) {
        console.error('❌ Playback error:', id, e);
        revoke();
        if (fromCache) {
          ttsCache.markStopped(id);
        }
      } finally {
        this.playingId = null;
      }

      if (this.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    this.processing = false;
    console.log('✅ Queue complete');
  }
}

const ttsManager = new TTSManager();

// Detect iOS
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
          }}>
            {label}
          </div>
        )}
        <div 
          onClick={(e) => onSpeak && onSpeak(text, messageId, e)}
          style={{
            ...bubbleStyle,
            padding: '16px 20px',
            fontSize: '17px',
            lineHeight: '1.5',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            cursor: onSpeak ? 'pointer' : 'default',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (onSpeak) {
              e.currentTarget.style.transform = 'scale(1.02)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.12)';
            }
          }}
          onMouseLeave={(e) => {
            if (onSpeak) {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
            }
          }}
        >
          <div>{text}</div>
          {translation && hasBeenClicked && (
            <div style={{
              fontSize: '14px',
              color: isUser ? 'rgba(255,255,255,0.8)' : '#6b7280',
              marginTop: '12px',
              paddingTop: '12px',
              borderTop: isUser ? '1px solid rgba(255,255,255,0.2)' : '1px solid #e5e7eb',
              fontStyle: 'italic',
            }}>
              {translation}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
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
  const [error, setError] = useState('');
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [translations, setTranslations] = useState(new Map());
  const [clickedBubbles, setClickedBubbles] = useState(new Set());
  const consecutiveFailuresRef = useRef(0);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const currentStreamRef = useRef(null); // Fresh stream per recording
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const recordingStartTimeRef = useRef(null);
  const isButtonPressedRef = useRef(false);
  const micPermissionGrantedRef = useRef(false);
  const [showFirstRunScreen, setShowFirstRunScreen] = useState(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallPrompt(true);
    };

    const handleAppInstalled = () => {
      console.log('PWA installed');
      setShowInstallPrompt(false);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (isiOS) {
      const hasSeenFirstRun = localStorage.getItem('hasSeenFirstRunScreen');
      if (!hasSeenFirstRun) {
        console.log('📱 iOS first run');
        setShowFirstRunScreen(true);
      }
    }
  }, []);

  useEffect(() => {
    const checkPermission = async () => {
      try {
        const storedPermission = localStorage.getItem('micPermissionGranted');
        if (storedPermission === 'true') {
          setMicPermissionGranted(true);
          micPermissionGrantedRef.current = true;
          console.log('Mic permission from storage');
          return;
        }

        if (navigator.permissions) {
          const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
          if (permissionStatus.state === 'granted') {
            setMicPermissionGranted(true);
            micPermissionGrantedRef.current = true;
            localStorage.setItem('micPermissionGranted', 'true');
            console.log('Mic permission from browser');
          }
        }
      } catch (err) {
        console.log('Could not check mic permission:', err);
      }
    };

    checkPermission();

    return () => {
      console.log('Cleanup on unmount');
      if (currentStreamRef.current) {
        currentStreamRef.current.getTracks().forEach(track => {
          track.stop();
          console.log('Cleanup: stopped track', track.id);
        });
        currentStreamRef.current = null;
      }
      if (mediaRecorderRef.current) {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current = null;
      }
      ttsCache.clear();
    };
  }, []);

  const handleInstallClick = () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('Install accepted');
        }
        setDeferredPrompt(null);
        setShowInstallPrompt(false);
      });
    }
  };

  const cancelProcessing = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      console.log('Request cancelled');
    }
    setIsProcessing(false);
    setError('');
  }, []);

  const requestMicPermissionOnce = useCallback(async () => {
    if (permissionRequested || isRequestingPermission) return;
    
    try {
      setIsRequestingPermission(true);
      setPermissionRequested(true);
      console.log('🎤 Requesting mic permission (prime)...');
      
      const constraints = {
        audio: {
          sampleRate: { ideal: 16000, min: 8000, max: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(isiOS && { sampleSize: 16, volume: 1.0 })
        }
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Stop immediately - just priming permission
      stream.getTracks().forEach(track => track.stop());
      
      localStorage.setItem('micPermissionGranted', 'true');
      setMicPermissionGranted(true);
      micPermissionGrantedRef.current = true;
      console.log('✅ Mic permission granted');
      
    } catch (err) {
      console.error('Mic permission denied:', err);
      setError('Microphone permission denied. Enable in browser settings.');
      setPermissionRequested(false);
    } finally {
      setIsRequestingPermission(false);
    }
  }, [permissionRequested, isRequestingPermission]);

  const startRecording = useCallback(async (e) => {
    console.log('🎤 startRecording');
    
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (isRecording || isProcessing || isRequestingPermission) {
      console.log('🎤 Busy - ignoring');
      return;
    }

    if (!micPermissionGranted) {
      console.log('🎤 No permission');
      return;
    }

    console.log('🎙️ Getting fresh stream...');
    
    try {
      setError('');
      audioChunksRef.current = [];

      // Detect iOS early so we can use it in constraints
      const isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

      const constraints = {
        audio: {
          sampleRate: { ideal: 16000, min: 8000, max: 48000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(isiOS && { sampleSize: 16, volume: 1.0 })
        }
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentStreamRef.current = stream;
      console.log('✅ Fresh stream acquired');

      setIsRecording(true);
      recordingStartTimeRef.current = Date.now();

      let mimeType = '';
      
      if (isiOS) {
        // Try audio/mp4 first for iOS, but check if supported
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        }
        console.log('📱 iOS detected, using mimeType:', mimeType || 'default');
      } else {
        const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
        for (const type of types) {
          if (MediaRecorder.isTypeSupported(type)) {
            mimeType = type;
            break;
          }
        }
        console.log('🖥️ Desktop/Android detected, using mimeType:', mimeType || 'default');
      }
      
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      console.log('🎙️ MediaRecorder created with actual mimeType:', mediaRecorder.mimeType);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('MediaRecorder stopped');
        
        // Stop stream immediately
        if (currentStreamRef.current) {
          currentStreamRef.current.getTracks().forEach(track => {
            track.stop();
            console.log('🛑 Stopped track:', track.id);
          });
          currentStreamRef.current = null;
        }
        
        // Cool-down period to let iOS AVFoundation fully tear down encoder
        // This prevents encoder state corruption on subsequent recordings
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('⏱️ Encoder cool-down complete');
        
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || mimeType });
          console.log('Audio blob:', audioBlob.size, 'bytes');
          mediaRecorderRef.current = null;
          await processAudio(audioBlob);
        } else {
          console.log('No audio data');
          setIsProcessing(false);
          setError('No audio recorded. Try speaking closer to the microphone.');
          mediaRecorderRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.start(1000);
      console.log('🎙️ Recording started');
    } catch (err) {
      setError('Error starting recording: ' + err.message);
      setIsRecording(false);
      if (currentStreamRef.current) {
        currentStreamRef.current.getTracks().forEach(track => track.stop());
        currentStreamRef.current = null;
      }
      console.error('Recording error:', err);
    }
  }, [isRecording, isProcessing, micPermissionGranted, isRequestingPermission]);

  const handleButtonPress = useCallback(async (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    
    if (isButtonPressedRef.current) return;
    isButtonPressedRef.current = true;

    if (!micPermissionGrantedRef.current) {
      await requestMicPermissionOnce();
      if (!micPermissionGrantedRef.current) {
        isButtonPressedRef.current = false;
        return;
      }
    }

    await startRecording(e);
  }, [requestMicPermissionOnce, startRecording]);

  const stopRecording = useCallback((e) => {
    e?.preventDefault();
    e?.stopPropagation();

    console.log('🛑 Button released');
    isButtonPressedRef.current = false;
    
    if (isRequestingPermission) {
      console.log('🛑 Requesting permission - ignoring');
      return;
    }
    
    if (!isRecording) {
      console.log('🛑 Not recording - ignoring');
      return;
    }

    const recordingDuration = Date.now() - (recordingStartTimeRef.current || 0);
    if (recordingDuration < 800) {
      console.log('⚠️ Too short:', recordingDuration + 'ms');
      setIsRecording(false);
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    console.log('🛑 Stopping recording (duration:', recordingDuration + 'ms)');
    setIsRecording(false);
    
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      console.log('🛑 MediaRecorder stopped');
    }
  }, [isRecording, isRequestingPermission]);

  const processAudio = useCallback(async (audioBlob) => {
    setIsProcessing(true);
    setError('');
    
    console.log('Processing audio:', audioBlob.size, 'bytes');
    
    // Ensure any lingering mic streams are stopped before processing
    if (currentStreamRef.current) {
      currentStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('🛑 Cleanup: Stopped lingering track:', track.id);
      });
      currentStreamRef.current = null;
    }
    
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    
    try {
      console.log('📦 Audio blob details:', {
        size: audioBlob.size,
        type: audioBlob.type || 'unknown'
      });
      
      const formData = new FormData();
      
      let filename = 'audio.mp4';
      if (audioBlob.type.includes('webm')) {
        filename = 'audio.webm';
      } else if (audioBlob.type.includes('ogg')) {
        filename = 'audio.ogg';
      } else if (audioBlob.type.includes('wav')) {
        filename = 'audio.wav';
      }
      
      console.log('📤 Sending to STT:', { filename, type: audioBlob.type });
      formData.append('audio', audioBlob, filename);

      // Retry logic for STT with exponential backoff
      const maxRetries = 3;
      let lastError = null;
      let sttData = null;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 1) {
            const delay = Math.pow(2, attempt - 1) * 250; // 500ms, 1000ms
            console.log(`🔄 STT retry attempt ${attempt}/${maxRetries} after ${delay}ms delay...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          
          const sttResponse = await fetch(`${API_BASE}/stt`, {
            method: 'POST',
            body: formData,
            signal
          });

          if (signal.aborted) return;

          if (!sttResponse.ok) {
            const errorText = await sttResponse.text();
            lastError = new Error(`STT failed: ${sttResponse.status}`);
            
            // Check if it's a decode error that might succeed on retry
            if (errorText.includes('could not be decoded') && attempt < maxRetries) {
              console.warn(`⚠️ Decode error on attempt ${attempt}, will retry...`);
              continue; // Try again
            }
            
            console.error('STT error:', errorText);
            throw lastError;
          }

          sttData = await sttResponse.json();
          
          // Success! Log if this was a retry
          if (attempt > 1) {
            console.log(`✅ STT succeeded on attempt ${attempt}`);
          }
          
          // Break out of retry loop on success
          lastError = null;
          break;
        } catch (fetchError) {
          lastError = fetchError;
          if (attempt === maxRetries || signal.aborted) {
            throw fetchError;
          }
        }
      }
      
      if (lastError || !sttData) {
        throw lastError || new Error('STT failed after retries');
      }

      // Success! Reset consecutive failure counter
      consecutiveFailuresRef.current = 0;

      const userText = sttData.text || '';

      const isSpuriousResponse = (text) => {
        const lowerText = text.toLowerCase().trim();
        const spuriousPatterns = [
          'subtítulos realizados por la comunidad de amara.org',
          'subtitulos realizados por la comunidad de amara.org',
          'subtitles made by the amara.org community',
          'thank you for watching',
          'www.amara.org',
          'amara.org',
        ];
        
        const punctuationOnly = ['.', ',', '?', '!'];
        return spuriousPatterns.some(pattern => {
          if (punctuationOnly.includes(pattern)) {
            return lowerText === pattern;
          } else {
            return lowerText.includes(pattern);
          }
        }) || lowerText.length < 2;
      };

      if (!userText.trim() || isSpuriousResponse(userText)) {
        console.log('Text filtered as spurious');
        setError('No speech detected. Try speaking louder.');
        return;
      }

      const newUserMessage = { role: 'user', text: userText };
      setMessages(prev => [...prev, newUserMessage]);

      const simpleHistory = [...messages, { role: 'user', content: userText }].map(msg => ({
        role: msg.role,
        content: msg.text || msg.content || [msg.correction_es, msg.reply_es].filter(Boolean).join(' ')
      }));

      if (signal.aborted) return;

      const chatResponse = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: simpleHistory, 
          translate: true
        }),
        signal
      });

      if (signal.aborted) return;

      if (!chatResponse.ok) {
        throw new Error(`Chat failed: ${chatResponse.status}`);
      }

      const data = await chatResponse.json();
      
      const assistantMessage = {
        role: 'assistant',
        correction_es: (data.correction_es && data.correction_es !== 'null') ? data.correction_es : null,
        reply_es: data.reply_es || '',
        translation_en: data.translation_en,
        needs_correction: !!data.needs_correction
      };

      // Calculate the assistant index BEFORE setState to avoid race conditions
      const actualAssistantIndex = messages.length;
      
      setMessages(prev => {
        const newMessages = [...prev, assistantMessage];
        const actualIndex = newMessages.length - 1;
        const userIndex = actualIndex - 1;
        
        if (userIndex >= 0 && newMessages[userIndex].role === 'user') {
          const userMessageId = `user-${userIndex}`;
          const userText = newMessages[userIndex].text;
          translateText(userText).then(translation => {
            if (translation) {
              setTranslations(prev => new Map(prev.set(userMessageId, translation)));
            }
          });
        }
        
        if (data.translation_en) {
          const newTranslations = new Map();
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

      const partsToPlay = [];
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
        console.log('🔊 Auto-playing AI response');
        
        for (const { text, messageId } of partsToPlay) {
          try {
            const response = await fetch(`${API_BASE}/tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text })
            });
            
            if (response.ok) {
              const blob = await response.blob();
              ttsCache.set(messageId, blob);
              ttsManager.enqueueBlob(messageId, blob);
            }
          } catch (e) {
            console.error('Auto-play fetch error:', e);
          }
        }
      }

    } catch (err) {
      console.error('Processing error:', err);
      if (err.name === 'AbortError') {
        console.log('Request cancelled');
        return;
      }
      
      // Track consecutive failures for Chrome iOS encoder corruption detection
      if (err.message.includes('STT failed') || err.message.includes('could not be decoded')) {
        consecutiveFailuresRef.current += 1;
        console.warn(`⚠️ Consecutive STT failures: ${consecutiveFailuresRef.current}`);
        
        // After 2 consecutive decode failures, suggest clearing to reset encoder
        if (consecutiveFailuresRef.current >= 2) {
          setError('Audio encoder issue detected. Tap "Clear" button to reset and try again.');
          console.error('🔧 Encoder likely corrupted - user should clear conversation');
        } else {
          setError('Audio quality issue detected. Please try recording again.');
        }
      } else if (err.message.includes('network') || err.message.includes('fetch')) {
        setError('Network issue. Check your connection and try again.');
      } else {
        setError('Error processing audio. Please try again.');
      }
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  }, [messages]);

  const translateText = useCallback(async (text) => {
    try {
      const response = await fetch(`${API_BASE}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: 'es', to: 'en' }),
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.translation;
      }
    } catch (error) {
      console.error('Translation error:', error);
    }
    return null;
  }, []);

  const speak = useCallback(async (text, messageId, event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    console.log('🔊 Speak:', messageId);
    
    if (messageId) {
      setClickedBubbles(prev => new Set(prev.add(messageId)));
    }
    
    if (ttsManager.stopIfPlaying(messageId)) {
      console.log('🛑 Stopped playing');
      return;
    }
    
    await ttsManager.prime();
    
    try {
      const cachedUrl = ttsCache.get(messageId);
      if (cachedUrl) {
        console.log('🎵 Using cache:', messageId);
        ttsManager.enqueueBlob(messageId, cachedUrl, true);
      } else {
        const response = await fetch(`${API_BASE}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        
        if (response.ok) {
          const blob = await response.blob();
          ttsCache.set(messageId, blob);
          ttsManager.enqueueBlob(messageId, blob, false);
        }
      }
    } catch (err) {
      console.error('TTS error:', err);
    }
    
    if (messageId && !translations.has(messageId)) {
      const translation = await translateText(text);
      if (translation) {
        setTranslations(prev => new Map(prev.set(messageId, translation)));
      }
    }
  }, [translations, translateText]);

  const clearConversation = useCallback(() => {
    setMessages([]);
    setError('');
    setTranslations(new Map());
    setClickedBubbles(new Set());
    ttsCache.clear();
    consecutiveFailuresRef.current = 0; // Reset encoder failure counter
    console.log('🔄 Conversation cleared - encoder state reset');
  }, []);

  const handleEnableAudio = useCallback(async () => {
    console.log('📱 iOS first-run: Enabling audio');
    await ttsManager.prime();
    await requestMicPermissionOnce();
    localStorage.setItem('hasSeenFirstRunScreen', 'true');
    setShowFirstRunScreen(false);
    console.log('✅ iOS first-run complete');
  }, [requestMicPermissionOnce]);

  return (
    <div style={{
      height: '100vh',
      height: '100dvh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      overflow: 'hidden',
    }}>
      
      {/* iOS First Run Screen */}
      {showFirstRunScreen && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.95)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '24px',
            padding: '40px 32px',
            maxWidth: '400px',
            textAlign: 'center',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: '64px', marginBottom: '24px' }}>🎤</div>
            <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '16px', color: '#1f2937' }}>
              Enable Audio
            </h2>
            <p style={{ fontSize: '16px', lineHeight: '1.6', color: '#6b7280', marginBottom: '32px' }}>
              To use voice features, we need permission to access your microphone and play audio.
            </p>
            <button
              onClick={handleEnableAudio}
              style={{
                width: '100%',
                padding: '16px 32px',
                fontSize: '18px',
                fontWeight: '600',
                color: 'white',
                backgroundColor: '#667eea',
                border: 'none',
                borderRadius: '16px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = '#5568d3';
                e.target.style.transform = 'scale(1.02)';
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = '#667eea';
                e.target.style.transform = 'scale(1)';
              }}
            >
              Enable Audio
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(10px)',
        paddingTop: 'max(20px, env(safe-area-inset-top))',
        paddingBottom: '20px',
        paddingLeft: '20px',
        paddingRight: '20px',
        boxShadow: '0 2px 20px rgba(0,0,0,0.1)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
        zIndex: 100,
      }}>
        <h1 style={{
          fontSize: '24px',
          fontWeight: '700',
          color: '#667eea',
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          🇪🇸 Spanish Tutor
        </h1>
        
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            onClick={clearConversation}
            style={{
              padding: '10px 16px',
              fontSize: '14px',
              fontWeight: '600',
              color: '#ef4444',
              backgroundColor: 'transparent',
              border: '2px solid #ef4444',
              borderRadius: '12px',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            🗑️ Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '24px 0',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#f3f4f6',
        WebkitOverflowScrolling: 'touch',
      }}>
        {messages.map((msg, index) => {
          if (msg.role === 'user') {
            const messageId = `user-${index}`;
            const translation = translations.get(messageId);
            const hasBeenClicked = clickedBubbles.has(messageId);
            
            return (
              <MessageBubble
                key={index}
                text={msg.text}
                isUser={true}
                onSpeak={speak}
                messageId={messageId}
                translation={translation}
                hasBeenClicked={hasBeenClicked}
              />
            );
          } else {
            const correctionId = `assistant-${index}-correction`;
            const replyId = `assistant-${index}-reply`;
            const correctionTranslation = translations.get(correctionId);
            const replyTranslation = translations.get(replyId);
            const correctionClicked = clickedBubbles.has(correctionId);
            const replyClicked = clickedBubbles.has(replyId);
            
            return (
              <div key={index}>
                {msg.correction_es && (
                  <MessageBubble
                    text={msg.correction_es}
                    isUser={false}
                    label="Correction"
                    onSpeak={speak}
                    messageId={correctionId}
                    translation={correctionTranslation}
                    hasBeenClicked={correctionClicked}
                  />
                )}
                {msg.reply_es && (
                  <MessageBubble
                    text={msg.reply_es}
                    isUser={false}
                    label={msg.correction_es ? "Reply" : null}
                    onSpeak={speak}
                    messageId={replyId}
                    translation={replyTranslation}
                    hasBeenClicked={replyClicked}
                  />
                )}
              </div>
            );
          }
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Error Display */}
      {error && (
        <div style={{
          position: 'fixed',
          bottom: '180px',
          left: '20px',
          right: '20px',
          padding: '16px',
          backgroundColor: '#fee2e2',
          border: '2px solid #ef4444',
          borderRadius: '12px',
          color: '#991b1b',
          fontSize: '14px',
          fontWeight: '600',
          textAlign: 'center',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          zIndex: 200,
        }}>
          {error}
        </div>
      )}

      {/* Processing Indicator */}
      {isProcessing && (
        <div style={{
          position: 'fixed',
          bottom: '180px',
          left: '20px',
          right: '20px',
          padding: '16px',
          backgroundColor: 'rgba(255, 255, 255, 0.98)',
          borderRadius: '12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          zIndex: 200,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '24px',
              height: '24px',
              border: '3px solid #667eea',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }} />
            <span style={{ fontSize: '16px', fontWeight: '600', color: '#667eea' }}>
              Processing...
            </span>
          </div>
          <button
            onClick={cancelProcessing}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: '600',
              color: '#ef4444',
              backgroundColor: 'transparent',
              border: '2px solid #ef4444',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Record Button */}
      <div style={{
        paddingTop: '24px',
        paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
        paddingLeft: '24px',
        paddingRight: '24px',
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(10px)',
        borderTop: '1px solid rgba(0,0,0,0.1)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <div
          onTouchStart={handleButtonPress}
          onTouchEnd={stopRecording}
          onMouseDown={handleButtonPress}
          onMouseUp={stopRecording}
          onMouseLeave={(e) => {
            if (isRecording) {
              stopRecording(e);
            }
          }}
          style={{
            width: '140px',
            height: '140px',
            borderRadius: '50%',
            backgroundColor: isRecording ? '#ef4444' : '#667eea',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: isRecording 
              ? '0 0 0 8px rgba(239, 68, 68, 0.2), 0 8px 24px rgba(239, 68, 68, 0.3)'
              : '0 8px 24px rgba(102, 126, 234, 0.3)',
            transform: isRecording ? 'scale(1.1)' : 'scale(1)',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            MozUserSelect: 'none',
            msUserSelect: 'none',
            WebkitTouchCallout: 'none',
            WebkitUserDrag: 'none',
            WebkitTapHighlightColor: 'transparent',
            padding: '20px',
          }}
        >
          <span style={{ 
            fontSize: '44px', 
            marginBottom: '6px',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            pointerEvents: 'none',
            lineHeight: '1',
          }}>
            {isRecording ? '⏸️' : '🎤'}
          </span>
          <span style={{
            fontSize: '11px',
            fontWeight: '700',
            color: 'white',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            pointerEvents: 'none',
            lineHeight: '1.2',
            textAlign: 'center',
          }}>
            {isRecording ? 'Recording' : 'Hold to Talk'}
          </span>
        </div>
      </div>

      {/* Install Prompt */}
      {showInstallPrompt && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '20px',
          right: '20px',
          backgroundColor: 'white',
          borderRadius: '16px',
          padding: '20px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          zIndex: 1000,
        }}>
          <p style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: '600', color: '#1f2937' }}>
            Install Spanish Tutor for offline access
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={handleInstallClick}
              style={{
                flex: 1,
                padding: '12px',
                fontSize: '16px',
                fontWeight: '600',
                color: 'white',
                backgroundColor: '#667eea',
                border: 'none',
                borderRadius: '12px',
                cursor: 'pointer',
              }}
            >
              Install
            </button>
            <button
              onClick={() => setShowInstallPrompt(false)}
              style={{
                flex: 1,
                padding: '12px',
                fontSize: '16px',
                fontWeight: '600',
                color: '#6b7280',
                backgroundColor: 'transparent',
                border: '2px solid #e5e7eb',
                borderRadius: '12px',
                cursor: 'pointer',
              }}
            >
              Later
            </button>
          </div>
        </div>
      )}

      <style>
        {`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          
          * {
            -webkit-tap-highlight-color: transparent;
          }
        `}
      </style>
    </div>
  );
}

export default App;
