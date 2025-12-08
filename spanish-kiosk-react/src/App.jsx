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
    this.cache = new Map(); // messageId -> { url, byteSize, lastUsed, isPlaying }
    this.maxSize = maxSize;
    this.totalBytes = 0;
    this.statsCounter = 0; // Log stats every 10 operations
  }

  get(messageId) {
    if (this.cache.has(messageId)) {
      const entry = this.cache.get(messageId);
      // Update LRU timestamp
      entry.lastUsed = Date.now();
      // Move to end (most recently used)
      this.cache.delete(messageId);
      this.cache.set(messageId, entry);
      console.log('🎵 Cache HIT:', messageId);
      this._logStats();
      return entry.url;
    }
    console.log('🎵 Cache MISS:', messageId);
    return null;
  }

  set(messageId, blob) {
    const url = URL.createObjectURL(blob);
    const entry = {
      url,
      byteSize: blob.size,
      lastUsed: Date.now(),
      isPlaying: false
    };

    // Try to evict if at capacity
    if (this.cache.size >= this.maxSize) {
      const victim = this._findLRUVictim();
      
      if (victim) {
        // Safe to evict
        const [victimId, victimEntry] = victim;
        console.log('🗑️ Evicting LRU:', victimId);
        URL.revokeObjectURL(victimEntry.url);
        this.totalBytes -= victimEntry.byteSize;
        this.cache.delete(victimId);
      } else {
        // All items are playing - use temp URL fallback
        console.warn('⚠️ Cache full, all playing. Using temp URL:', messageId);
        this._logStats();
        return { url, isTemp: true }; // Return temp URL marker
      }
    }
    
    this.cache.set(messageId, entry);
    this.totalBytes += entry.byteSize;
    console.log('💾 Cached TTS:', messageId, '| Cache size:', this.cache.size);
    this._logStats();
    return { url, isTemp: false };
  }

  markPlaying(messageId, playing = true) {
    const entry = this.cache.get(messageId);
    if (entry) {
      entry.isPlaying = playing;
      entry.lastUsed = Date.now();
    }
  }

  markStopped(messageId) {
    this.markPlaying(messageId, false);
  }

  _findLRUVictim() {
    let oldest = null;
    let oldestTime = Infinity;
    
    for (const [id, entry] of this.cache.entries()) {
      if (!entry.isPlaying && entry.lastUsed < oldestTime) {
        oldest = [id, entry];
        oldestTime = entry.lastUsed;
      }
    }
    
    return oldest;
  }

  _logStats() {
    this.statsCounter++;
    if (this.statsCounter % 10 === 0) {
      const playingCount = Array.from(this.cache.values()).filter(e => e.isPlaying).length;
      console.log(`📊 Cache stats: ${this.cache.size}/${this.maxSize} items, ${(this.totalBytes / 1024 / 1024).toFixed(2)}MB, ${playingCount} playing`);
    }
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
    this.isResetting = false;
    this.playAbort = null;
    this.onQueueComplete = null;
    this.playCount = 0; // Track plays for audio element rotation
    this.rotateEvery = 20; // Rotate audio element every N plays
  }

  ensureAudioEl() {
    if (this.audio) return;
    this._createAudioElement();
  }

  _createAudioElement() {
    console.log('🎵 Creating audio element');
    const newAudio = document.createElement('audio');
    newAudio.setAttribute('playsinline', '');
    newAudio.preload = 'auto';
    
    // Preserve settings if rotating
    if (this.audio) {
      newAudio.volume = this.audio.volume;
      newAudio.muted = this.audio.muted;
      this.audio.remove();
    }
    
    document.body.appendChild(newAudio);
    this.audio = newAudio;
  }

  _maybeRotateAudioElement() {
    if (this.playCount > 0 && this.playCount % this.rotateEvery === 0) {
      if (!this.isPlaying() && !this.processing) {
        console.log('🔄 Rotating audio element (plays:', this.playCount + ')');
        this._createAudioElement();
        this.primed = false; // Need to re-prime after rotation
      }
    }
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
    this.ensureAudioEl();
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

  pauseIfPlaying(options = {}) {
    if (this.isPlaying() || this.playingId) {
      // Abort current playback - this resolves the pending await
      this.playAbort?.abort();
      
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      
      // Clear playing flag in cache for current item
      if (this.playingId) {
        ttsCache.markStopped(this.playingId);
      }
      
      // Clear state to prevent queue re-entry
      this.playingId = null;
      this.processing = false;
      
      // Clear callback - auto-play was interrupted
      this.onQueueComplete = null;
      
      // Clear queue - recording takes priority
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        // Mark as stopped in cache if it was cached
        if (item.fromCache) {
          ttsCache.markStopped(item.id);
        }
        try {
          item.revoke();
        } catch (e) {}
      }
      
      console.log('⏸️ Paused TTS for', options.reason || 'unknown');
    }
  }

  resumeIfPausedBy(reason) {
    // No-op now - we don't save/restore TTS state
    // Recording takes priority, TTS starts fresh after
  }

  beginReset() {
    console.log('🧹 Begin TTS reset (quiesce)');
    this.isResetting = true;
  }

  endReset() {
    console.log('✅ End TTS reset (ready)');
    this.isResetting = false;
  }

  clearQueue() {
    // Abort current playback if any
    this.playAbort?.abort();
    
    // Clear playing flag for current item
    if (this.playingId) {
      ttsCache.markStopped(this.playingId);
      this.playingId = null;
    }
    
    // Clear callback - queue is being cleared
    this.onQueueComplete = null;
    
    // Revoke all queued blob URLs and clear playing flags
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item.fromCache) {
        ttsCache.markStopped(item.id);
      }
      try {
        item.revoke();
      } catch (e) {
        console.warn('Error revoking URL:', e);
      }
    }
    console.log('🗑️ Queue cleared');
  }

  stopIfPlaying(id) {
    // Idempotent - safe to call even if nothing playing
    if (!this.audio) return false;
    
    if (id && this.playingId !== id) {
      return false;
    }
    
    if (this.isPlaying() || this.playingId) {
      // Abort current playback
      this.playAbort?.abort();
      
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch (e) {
        console.warn('Audio stop error:', e);
      }
      
      const wasPlaying = this.playingId;
      this.playingId = null;
      this.processing = false;
      if (wasPlaying) {
        console.log('🛑 Stopped:', wasPlaying);
      }
      
      // Only continue queue if not resetting
      if (!this.isResetting) {
        queueMicrotask(() => {
          if (this.queue.length > 0 && !this.processing && !this.isResetting) {
            this._process();
          }
        });
      }
      
      return true;
    }
    return false;
  }

  async _process() {
    if (this.isResetting) {
      console.log('⏸️ Skipping _process - resetting');
      return;
    }
    
    if (this.processing || !this.queue.length) {
      if (this.processing) console.log('⏸️ Already processing');
      return;
    }

    this.processing = true;
    console.log('🔄 Processing queue, items:', this.queue.length);

    while (this.queue.length > 0) {
      // Check if we should abort processing
      if (this.isResetting) {
        console.log('⏹️ Aborting _process - reset in progress');
        this.processing = false;
        return;
      }
      
      const { id, url, revoke, fromCache } = this.queue.shift();
      this.playingId = id;
      
      if (fromCache) {
        ttsCache.markPlaying(id, true);
      }
      
      console.log('🔊 Playing:', id);

      // Create new AbortController for this playback
      this.playAbort?.abort();
      this.playAbort = new AbortController();

      try {
        this.audio.src = url;
        try {
          await this.audio.play();
        } catch (playError) {
          // Check if it's an autoplay policy error (requires user gesture)
          if (playError.name === 'NotAllowedError') {
            console.warn('⚠️ Autoplay blocked - requires user gesture. Setting prime flag.');
            // Set flag to prime on next gesture
            if (typeof window !== 'undefined' && window.needsAudioPrimeRef) {
              window.needsAudioPrimeRef.current = { pending: true, lastMsgId: id };
            }
            // Clean up and break out of loop
            revoke();
            if (fromCache) {
              ttsCache.markStopped(id);
            }
            this.playingId = null;
            // Continue to next item or complete
            continue;
          }
          
          // For other errors, retry once with fresh audio element
          console.warn('⚠️ Play failed, recreating element and retrying:', playError.message);
          this._createAudioElement();
          this.audio.src = url;
          await this.audio.play();
        }
        
        // Increment play counter
        this.playCount++;
        
        // Wait for audio to end or be aborted
        await this._waitForAudioEnd(this.audio, this.playAbort.signal);
        
        console.log('✅ Ended:', id);
        revoke();
        if (fromCache) {
          ttsCache.markStopped(id);
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          console.log('⏹️ Aborted:', id);
        } else {
          console.error('❌ Playback error:', id, e);
          // Rotate audio element on error
          this._maybeRotateAudioElement();
        }
        revoke();
        if (fromCache) {
          ttsCache.markStopped(id);
        }
      } finally {
        this.playingId = null;
      }

      // Check if we should rotate audio element
      this._maybeRotateAudioElement();

      if (this.queue.length > 0 && !this.isResetting) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    this.processing = false;
    console.log('✅ Queue complete');
    
    // Notify that queue processing is complete
    if (this.onQueueComplete) {
      this.onQueueComplete();
    }
  }

  _waitForAudioEnd(audio, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onEnded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('audio error')); };
      const onAbort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')); };

      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
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
  // Coordination layer - shared busy state (no re-renders)
  const busyRef = useRef({
    isRecording: false,
    isProcessing: false,
    autoTTSPlaying: false
  });
  
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
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [error, setError] = useState('');
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [captureMode, setCaptureMode] = useState('mp4'); // 'mp4' or 'wav'
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [appLifecycle, setAppLifecycle] = useState('ready'); // 'ready' | 'backgrounded' | 'needs-resume'
  const isResettingRef = useRef(false);
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [translations, setTranslations] = useState(new Map());
  const [clickedBubbles, setClickedBubbles] = useState(new Set());
  const consecutiveFailuresRef = useRef(0);
  const wavSuccessCountRef = useRef(0);

  const recorderRef = useRef(null); // Single-owner MediaRecorder tracking
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const currentStreamRef = useRef(null); // Fresh stream per recording
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const recordingStartTimeRef = useRef(null);
  const isButtonPressedRef = useRef(false);
  const micPermissionGrantedRef = useRef(false);
  const currentOpIdRef = useRef(0);
  const audioContextRef = useRef(null); // WAV mode AudioContext
  const audioWorkletNodeRef = useRef(null); // WAV mode AudioWorklet
  const workletReadyRef = useRef(false); // WAV mode initialization flag
  const isAcquiringStreamRef = useRef(false); // Prevents overlapping getUserMedia calls
  const acquireTokenRef = useRef(0); // Monotonic token to ignore late stream results
  const needsAudioPrimeRef = useRef({ pending: false, lastMsgId: null }); // Tracks when audio needs gesture
  const [showFirstRunScreen, setShowFirstRunScreen] = useState(false);

  // Expose needsAudioPrimeRef to window for TTSManager access
  useEffect(() => {
    window.needsAudioPrimeRef = needsAudioPrimeRef;
    return () => {
      delete window.needsAudioPrimeRef;
    };
  }, []);

  // Fix #5: Persist chat messages to localStorage
  useEffect(() => {
    if (messages.length > 1) { // Don't save just the initial greeting
      try {
        localStorage.setItem('chatMessages', JSON.stringify(messages));
        console.log('💾 Persisted', messages.length, 'messages');
      } catch (e) {
        console.warn('Failed to persist messages:', e);
      }
    }
  }, [messages]);

  // Fix #5: Restore chat messages on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('chatMessages');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
          console.log('📥 Restored', parsed.length, 'messages from storage');
        }
      }
    } catch (e) {
      console.warn('Failed to restore messages:', e);
    }
  }, []);

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
    const handleVisibilityChange = () => {
      if (document.hidden) {
        console.log('[lifecycle] -> backgrounded');
        setAppLifecycle('backgrounded');
        // Persist resume requirement for next session
        sessionStorage.setItem('needsResume', '1');
        // Optional: gracefully stop any in-progress operations
        if (busyRef.current.isRecording || busyRef.current.isProcessing) {
          console.log('[lifecycle] Operations in progress, will need resume');
        }
      } else {
        console.log('[lifecycle] -> needs-resume (coming back from background)');
        setAppLifecycle('needs-resume');
        sessionStorage.setItem('needsResume', '1');
      }
    };

    const handlePageHide = () => {
      console.log('[lifecycle] pagehide -> marking needs resume');
      sessionStorage.setItem('needsResume', '1');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, []);

  // Fix #1 part 3: Check for persisted resume requirement on boot
  useEffect(() => {
    if (sessionStorage.getItem('needsResume')) {
      console.log('[lifecycle] Boot: Resume required from previous session');
      setAppLifecycle('needs-resume');
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
          // Auto-prime audio for this session (iOS requires re-prime after reload)
          if (!showFirstRunScreen) {
            setTimeout(() => {
              ttsManager.prime().catch(e => {
                console.warn('⚠️ Auto-prime failed, will retry on first gesture:', e.message);
              });
            }, 500);
          }
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

  const resetAudioStack = useCallback(async () => {
    if (isResettingRef.current) {
      console.log('[lifecycle] Already resetting, skipping');
      return;
    }

    isResettingRef.current = true;
    ttsManager.isResetting = true;
    console.log('[lifecycle] 🔄 Starting audio stack reset...');

    try {
      // Step 1: Stop TTS playback
      console.log('[lifecycle] Step 1: Stopping TTS playback');
      try {
        ttsManager.beginReset();
        ttsManager.stopIfPlaying();
        ttsManager.clearQueue();
      } catch (e) {
        console.warn('[lifecycle] TTS stop warning:', e.message || e);
      }

      // Step 2: Abort network requests
      console.log('[lifecycle] Step 2: Aborting network requests');
      try {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
      } catch (e) {
        console.warn('[lifecycle] Abort controller warning:', e.message || e);
      }

      // Step 3: Stop microphone streams
      console.log('[lifecycle] Step 3: Stopping microphone');
      try {
        if (currentStreamRef.current) {
          currentStreamRef.current.getTracks().forEach(track => {
            try {
              track.stop();
              console.log('[lifecycle] Stopped track:', track.id);
            } catch (e) {
              console.warn('[lifecycle] Track stop warning:', e.message || e);
            }
          });
          currentStreamRef.current = null;
        }
        // Clear acquisition flag
        isAcquiringStreamRef.current = false;
      } catch (e) {
        console.warn('[lifecycle] Stream stop warning:', e.message || e);
      }

      // Step 4: Stop MediaRecorder with awaited stop
      console.log('[lifecycle] Step 4: Stopping MediaRecorder');
      try {
        if (recorderRef.current) {
          if (!recorderRef.current.isWAV && recorderRef.current.state === 'recording') {
            await stopRecorder(recorderRef.current);
            console.log('[lifecycle] MediaRecorder stopped');
          } else if (recorderRef.current.isWAV) {
            // WAV mode cleanup
            if (recorderRef.current.stop) {
              await recorderRef.current.stop();
            }
          }
          recorderRef.current = null;
        }
        if (mediaRecorderRef.current) {
          mediaRecorderRef.current = null;
        }
      } catch (e) {
        console.warn('[lifecycle] MediaRecorder stop warning:', e.message || e);
      }

      // Step 5: Destroy TTS audio element
      console.log('[lifecycle] Step 5: Destroying TTS audio element');
      try {
        if (ttsManager.audio) {
          ttsManager.audio.pause();
          ttsManager.audio.removeAttribute('src');
          ttsManager.audio.remove();
          console.log('[lifecycle] TTS audio element removed');
        }
      } catch (e) {
        console.warn('[lifecycle] TTS audio cleanup warning:', e.message || e);
      }
      ttsManager.audio = null;
      ttsManager.primed = false;

      // Step 6: Close AudioContext with timeout and reset flags
      console.log('[lifecycle] Step 6: Closing AudioContext');
      if (audioContextRef.current) {
        try {
          if (audioContextRef.current.state !== 'closed') {
            console.log('[lifecycle] AudioContext state:', audioContextRef.current.state);
            await Promise.race([
              audioContextRef.current.close(),
              new Promise(resolve => setTimeout(resolve, 1000))
            ]);
            console.log('[lifecycle] AudioContext closed or timed out');
          } else {
            console.log('[lifecycle] AudioContext already closed');
          }
        } catch (e) {
          console.warn('[lifecycle] AudioContext close warning:', e.message || e);
        }
      }
      // Always null out refs and flags
      audioContextRef.current = null;
      audioWorkletNodeRef.current = null;
      workletReadyRef.current = false;
      console.log('[lifecycle] AudioContext refs cleared, worklet flag reset');

      // Step 7: Reset failure counters (keep current capture mode)
      console.log('[lifecycle] Step 7: Resetting failure counters');
      consecutiveFailuresRef.current = 0;
      wavSuccessCountRef.current = 0;

      // Step 8: Increment operation ID
      currentOpIdRef.current++;
      console.log('[lifecycle] Step 8: Incremented operation ID to', currentOpIdRef.current);

      // Success
      setAppLifecycle('ready');
      sessionStorage.removeItem('needsResume');
      // Set flag to require audio prime on next gesture
      needsAudioPrimeRef.current = { pending: true, lastMsgId: null };
      console.log('[lifecycle] ✅ Audio stack reset complete, ready to use (audio prime required on next gesture)');

    } catch (e) {
      // Fatal error - log details and mark as error state
      console.error('[lifecycle] ❌ Fatal reset error:', e.message || e, e.stack);
      setAppLifecycle('ready'); // Still unblock UI, but user may need to reload
      setError('Audio system error after resume. If issues persist, refresh the page.');
    } finally {
      // ALWAYS clear these flags, no matter what happened
      console.log('[lifecycle] Cleanup: Clearing all state flags');
      
      // TTS state
      ttsManager.isResetting = false;
      ttsManager.processing = false;
      ttsManager.playingId = null;
      ttsManager.onQueueComplete = null;
      
      // Coordination flags
      busyRef.current.isRecording = false;
      busyRef.current.isProcessing = false;
      busyRef.current.autoTTSPlaying = false;
      
      // UI state
      setIsRecording(false);
      setIsProcessing(false);
      setIsCleaningUp(false);
      
      // React ref
      isResettingRef.current = false;
      
      console.log('[lifecycle] Cleanup complete, all flags cleared');
    }
  }, []);

  // Helper: Wait for MediaRecorder to fully stop
  const stopRecorder = useCallback((recorder) => {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      // Listen for both stop and final dataavailable
      recorder.addEventListener('stop', finish, { once: true });
      recorder.addEventListener('dataavailable', finish, { once: true });

      // Trigger stop if not already stopped
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          finish(); // Already stopped
        }
      } catch (e) {
        console.warn('stopRecorder error:', e.message);
        finish();
      }

      // Timeout fuse to prevent hanging
      setTimeout(finish, 300);
    });
  }, []);

  const cancelProcessing = useCallback(() => {
    console.log('🛑 Cancel pressed');

    // 1) Bump operation ID (ignore late async completions)
    const myOp = ++currentOpIdRef.current;

    // 2) Begin TTS reset
    ttsManager.beginReset();

    try {
      // 3) Stop audio and clear queue
      ttsManager.stopIfPlaying();
      ttsManager.clearQueue();
      ttsManager.processing = false;
      ttsManager.playingId = null;

      // 4) Abort network requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // 5) Stop microphone - ALL tracks
      if (currentStreamRef.current) {
        currentStreamRef.current.getTracks().forEach(track => {
          track.stop();
          console.log('🛑 Stopped track:', track.id);
        });
        currentStreamRef.current = null;
      }

      // 6) Stop MediaRecorder (use recorderRef)
      if (recorderRef.current) {
        if (recorderRef.current.isWAV && recorderRef.current.stop) {
          recorderRef.current.stop().catch(e => console.warn('Cancel WAV stop error:', e));
        } else if (recorderRef.current.state === 'recording') {
          recorderRef.current.stop();
        }
        recorderRef.current = null;
      }
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current = null;
      }
      
      // 7) Clear acquisition flag
      isAcquiringStreamRef.current = false;
    } catch (e) {
      console.error('Cancel error:', e);
    } finally {
      // 7) Clear coordination flags
      busyRef.current.isRecording = false;
      busyRef.current.isProcessing = false;
      busyRef.current.autoTTSPlaying = false;
      setIsProcessing(false);

      // 8) End TTS reset
      ttsManager.endReset();

      setError('');
      console.log('✅ Cancel complete (op:', myOp, ')');
    }
  }, []);

  // Build WAV file with 44-byte header + PCM data
  const createWAVBlob = useCallback((pcm16Data, sampleRate) => {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = pcm16Data.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    // WAV header
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    
    // PCM data
    const dataView = new Int16Array(buffer, 44);
    dataView.set(pcm16Data);
    
    return new Blob([buffer], { type: 'audio/wav' });
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
    console.log('🎤 startRecording (mode:', captureMode, ')');
    
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Lifecycle guard - block if app needs resume
    if (appLifecycle !== 'ready') {
      console.log('[lifecycle] Blocking startRecording(), state =', appLifecycle);
      return;
    }

    // Single-owner check - block if recorder already exists
    if (recorderRef.current) {
      console.log('🎤 Recorder already active - ignoring');
      return;
    }

    if (isRecording || isProcessing || isRequestingPermission || isCleaningUp) {
      console.log('🎤 Busy - ignoring (isCleaningUp:', isCleaningUp, ')');
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

      // Set single-flight flag and capture token
      isAcquiringStreamRef.current = true;
      const myToken = ++acquireTokenRef.current;
      console.log(`🔑 Acquire token: ${myToken}`);

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
      
      // Check if this result is stale (another acquisition started)
      if (acquireTokenRef.current !== myToken) {
        console.log(`❌ Late stream (token ${myToken}), stopping immediately`);
        stream.getTracks().forEach(track => {
          track.stop();
          console.log(`🛑 Stopped late track: ${track.id}`);
        });
        return;
      }
      
      currentStreamRef.current = stream;
      console.log('✅ Fresh stream acquired');

      setIsRecording(true);
      recordingStartTimeRef.current = Date.now();

        // WAV fallback mode: Use Web Audio API instead of MediaRecorder
      if (captureMode === 'wav') {
        console.log('🎵 Using WAV capture mode (AudioWorklet/ScriptProcessor)');
        
        // Fix #3C: Create fresh AudioContext if needed
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        let audioContext = audioContextRef.current;
        
        if (!audioContext || audioContext.state === 'closed') {
          audioContext = new AudioContext({ sampleRate: 16000 });
          audioContextRef.current = audioContext;
          console.log('🎵 Created fresh AudioContext');
        }
        
        // Resume context inside user gesture (iOS requirement)
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
          console.log('✅ AudioContext resumed');
        }
        
        const source = audioContext.createMediaStreamSource(stream);
        const pcmChunks = [];
        
        // Fix #3A: Synchronous capture flag (not React state)
        let capturing = true;
        
        let processorNode;
        const maxDuration = 25000; // 25s cap for WAV mode
        const startTime = Date.now();
        let warmupReadyTime = null; // Will be set after worklet/processor init
        
        // Try AudioWorklet first, fallback to ScriptProcessor
        const useWorklet = typeof AudioWorkletNode !== 'undefined' && audioContext.audioWorklet;
        
        if (useWorklet) {
          // AudioWorklet (preferred, non-deprecated)
          try {
            const workletCode = `
              class PCMRecorderProcessor extends AudioWorkletProcessor {
                process(inputs, outputs, parameters) {
                  const input = inputs[0];
                  if (input && input[0]) {
                    const inputData = input[0];
                    const pcm16 = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                      const s = Math.max(-1, Math.min(1, inputData[i]));
                      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    this.port.postMessage(pcm16);
                  }
                  return true;
                }
              }
              registerProcessor('pcm-recorder-processor', PCMRecorderProcessor);
            `;
            const blob = new Blob([workletCode], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            
            await audioContext.audioWorklet.addModule(url);
            processorNode = new AudioWorkletNode(audioContext, 'pcm-recorder-processor');
            
            // Fix #3A: Use synchronous capturing flag
            processorNode.port.onmessage = (e) => {
              if (capturing && (Date.now() - startTime) < maxDuration) {
                pcmChunks.push(e.data);
              }
            };
            
            // Fix #3B: Connect to sink to make graph pullable
            source.connect(processorNode);
            processorNode.connect(audioContext.destination);
            console.log('✅ AudioWorklet initialized and connected to sink');
            URL.revokeObjectURL(url);
            
            // Set warm-up time: give worklet 100ms to stabilize
            warmupReadyTime = Date.now() + 100;
            console.log('⏱️ WAV warm-up: 100ms');
          } catch (workletError) {
            console.warn('⚠️ AudioWorklet failed, falling back to ScriptProcessor:', workletError);
            useWorklet = false;
          }
        }
        
        if (!useWorklet) {
          // ScriptProcessor fallback (deprecated but widely supported)
          processorNode = audioContext.createScriptProcessor(4096, 1, 1);
          // Fix #3A: Use synchronous capturing flag
          processorNode.onaudioprocess = (e) => {
            if (capturing && (Date.now() - startTime) < maxDuration) {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              pcmChunks.push(pcm16);
            }
          };
          source.connect(processorNode);
          processorNode.connect(audioContext.destination);
          console.log('✅ ScriptProcessor initialized and connected to sink');
          
          // Set warm-up time: give processor 100ms to stabilize
          warmupReadyTime = Date.now() + 100;
          console.log('⏱️ WAV warm-up: 100ms');
        }
        
        // Store WAV cleanup function in recorderRef
        const wavRecorder = {
          isWAV: true,
          audioContext,
          source,
          processorNode,
          stream,
          stop: async () => {
            console.log('🛑 WAV: Stopping capture...');
            
            // Fix #3A: Stop accepting new data immediately
            capturing = false;
            
            // Wait for warm-up period if needed
            if (warmupReadyTime) {
              const waitMs = warmupReadyTime - Date.now();
              if (waitMs > 0) {
                console.log(`⏳ Waiting ${waitMs}ms for WAV warm-up...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
              }
            }
            
            // Drain window: wait for pending frames
            if (pcmChunks.length === 0) {
              console.log('⚠️ No PCM data yet, waiting 200ms for pending frames...');
              await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            // Disconnect nodes
            if (processorNode) {
              processorNode.disconnect();
              if (useWorklet && processorNode.port) {
                processorNode.port.close();
              }
            }
            source.disconnect();
            
            // Fix #3C: Close and null context
            await audioContext.close();
            audioContextRef.current = null;
            
            // Stop stream
            stream.getTracks().forEach(track => {
              track.stop();
              console.log('🛑 WAV: Stopped track:', track.id);
            });
            
            // Build WAV blob
            if (pcmChunks.length > 0) {
              const totalLength = pcmChunks.reduce((acc, arr) => acc + arr.length, 0);
              console.log(`📊 WAV collected ${pcmChunks.length} chunks, ${totalLength} PCM samples`);
              
              const wavBuffer = new Int16Array(totalLength);
              let offset = 0;
              for (const chunk of pcmChunks) {
                wavBuffer.set(chunk, offset);
                offset += chunk.length;
              }
              
              const wavBlob = createWAVBlob(wavBuffer, 16000);
              
              // Sanity check: header (44 bytes) + PCM data should match blob size
              const expectedSize = 44 + (wavBuffer.length * 2);
              if (wavBlob.size !== expectedSize) {
                console.error('⚠️ WAV size mismatch! Expected:', expectedSize, 'Got:', wavBlob.size);
              }
              
              console.log('📦 WAV blob:', wavBlob.size, 'bytes (header: 44, data:', wavBuffer.length * 2, ')');
              
              // Cleanup refs
              pcmChunks.length = 0;
              
              return wavBlob;
            } else {
              console.error('❌ No WAV data captured after warm-up. Chunks:', pcmChunks.length);
            }
            return null;
          }
        };
        
        recorderRef.current = wavRecorder;
        mediaRecorderRef.current = wavRecorder; // Backward compat
        workletReadyRef.current = true;
        console.log('🎙️ WAV recording started');
        return;
      }

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
        setIsCleaningUp(true);
        
        // Stop stream immediately
        if (currentStreamRef.current) {
          currentStreamRef.current.getTracks().forEach(track => {
            track.stop();
            console.log('🛑 Stopped track:', track.id);
          });
          currentStreamRef.current = null;
        }
        
        // Clear recorderRef first
        recorderRef.current = null;
        
        // Process audio FIRST before cooldown
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
        
        // Cool-down period AFTER processing
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('⏱️ Encoder cool-down complete');
        setIsCleaningUp(false);
      };

      recorderRef.current = mediaRecorder;
      mediaRecorderRef.current = mediaRecorder; // Backward compat
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
    } finally {
      // Always clear acquisition flag
      isAcquiringStreamRef.current = false;
    }
  }, [isRecording, isProcessing, micPermissionGranted, isRequestingPermission, isCleaningUp, captureMode, appLifecycle]);

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

    // Prime audio if needed (after resume or autoplay block)
    if (needsAudioPrimeRef.current.pending) {
      console.log('🔑 Priming audio from user gesture (record button)');
      try {
        await ttsManager.prime();
        needsAudioPrimeRef.current = { pending: false, lastMsgId: null };
        console.log('✅ Audio primed from gesture');
      } catch (e) {
        console.warn('⚠️ Prime from gesture failed:', e.message);
      }
    }

    // Pause any playing TTS and claim recording lane
    busyRef.current.isRecording = true;
    ttsManager.pauseIfPlaying({ reason: 'recording' });

    await startRecording(e);
  }, [requestMicPermissionOnce, startRecording]);

  const stopRecording = useCallback(async (e) => {
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
      // Use recorderRef for checks
      if (recorderRef.current?.isWAV) {
        if (recorderRef.current.stop) {
          await recorderRef.current.stop();
        }
        recorderRef.current = null;
        // Prevent AudioContext leak on short WAV recordings
        audioContextRef.current = null;
        audioWorkletNodeRef.current = null;
        workletReadyRef.current = false;
      } else if (recorderRef.current?.state === 'recording') {
        await stopRecorder(recorderRef.current);
        recorderRef.current = null;
      }
      mediaRecorderRef.current = null;
      return;
    }

    console.log('🛑 Stopping recording (duration:', recordingDuration + 'ms)');
    
    // Claim processing lane immediately (before async blob arrives)
    busyRef.current.isRecording = false;
    busyRef.current.isProcessing = true;
    setIsRecording(false);
    
    // Handle both MediaRecorder and WAV modes using recorderRef
    if (recorderRef.current?.isWAV) {
      // WAV mode cleanup
      setIsCleaningUp(true);
      try {
        const wavBlob = await recorderRef.current.stop();
        recorderRef.current = null;
        mediaRecorderRef.current = null;
        
        if (wavBlob && wavBlob.size > 0) {
          await processAudio(wavBlob);
        } else {
          console.log('No WAV data');
          setIsProcessing(false);
          setError('No audio recorded. Try speaking closer to the microphone.');
        }
      } catch (err) {
        console.error('WAV stop error:', err);
        setIsProcessing(false);
        setError('Error stopping WAV recording.');
      } finally {
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('⏱️ WAV cool-down complete');
        setIsCleaningUp(false);
      }
    } else if (recorderRef.current?.state === 'recording') {
      // MP4 MediaRecorder mode - use awaited stop
      console.log('🛑 Stopping MediaRecorder');
      await stopRecorder(recorderRef.current);
      console.log('🛑 MediaRecorder stopped');
    }
  }, [isRecording, isRequestingPermission, stopRecorder]);

  const processAudio = useCallback(async (audioBlob) => {
    const startTime = Date.now();
    const myOpId = ++currentOpIdRef.current;
    
    setIsProcessing(true);
    setError('');
    
    console.log('📤 Processing audio (opId:', myOpId, '):', audioBlob.size, 'bytes, type:', audioBlob.type, 'mode:', captureMode);
    
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

      // Success! Log telemetry and track WAV successes
      const roundTripMs = Date.now() - startTime;
      
      // Check if operation was cancelled/superseded
      if (currentOpIdRef.current !== myOpId) {
        console.log('🚫 Late completion ignored (opId:', myOpId, 'vs current:', currentOpIdRef.current, ')');
        return;
      }
      
      console.log('✅ STT SUCCESS:', {
        mode: captureMode,
        blobSize: audioBlob.size,
        roundTripMs,
        transcription: (sttData.text || '').substring(0, 50) + ((sttData.text || '').length > 50 ? '...' : '')
      });
      
      consecutiveFailuresRef.current = 0;
      
      if (captureMode === 'wav') {
        wavSuccessCountRef.current += 1;
        console.log(`✅ WAV success count: ${wavSuccessCountRef.current}`);
        
        // After 3 successful WAV recordings, try MP4 again
        if (wavSuccessCountRef.current >= 3) {
          console.log('🔄 MODE SWITCH: WAV → MP4 (WAV successes:', wavSuccessCountRef.current, ')');
          setCaptureMode('mp4');
          wavSuccessCountRef.current = 0;
          consecutiveFailuresRef.current = 0; // Reset MP4 failure counter when switching
        }
      }

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
      
      // Check if operation was cancelled/superseded
      if (currentOpIdRef.current !== myOpId) {
        console.log('🚫 Late chat response ignored (opId:', myOpId, ')');
        return;
      }
      
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
        
        // Transition from processing to auto-play
        busyRef.current.isProcessing = false;
        busyRef.current.autoTTSPlaying = true;
        
        // Set up callback to clear flag when queue completes
        ttsManager.onQueueComplete = () => {
          busyRef.current.autoTTSPlaying = false;
          console.log('🎵 Auto-play complete, cleared autoTTSPlaying flag');
          ttsManager.onQueueComplete = null;
        };
        
        for (const { text, messageId } of partsToPlay) {
          try {
            const response = await fetch(`${API_BASE}/tts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text })
            });
            
            if (response.ok) {
              const blob = await response.blob();
              const cacheResult = ttsCache.set(messageId, blob);
              
              if (cacheResult.isTemp) {
                // Temp URL - enqueue with special handling
                console.log('🎵 Using temp URL for:', messageId);
                ttsManager.enqueueBlob(messageId, cacheResult.url, false);
              } else {
                // Cached URL - enqueue normally
                ttsManager.enqueueBlob(messageId, cacheResult.url, true);
              }
            }
          } catch (e) {
            console.error('Auto-play fetch error:', e);
          }
        }
        
        // Note: busyRef.current.autoTTSPlaying will be cleared by finally block
      } else {
        // No auto-play, go straight to idle
        busyRef.current.isProcessing = false;
        ttsManager.resumeIfPausedBy('recording');
      }

    } catch (err) {
      const roundTripMs = Date.now() - startTime;
      
      // Ignore late errors from cancelled operations
      if (currentOpIdRef.current !== myOpId) {
        console.log('🚫 Late error ignored (opId:', myOpId, ')');
        return;
      }
      
      console.error('❌ STT FAILURE:', {
        mode: captureMode,
        blobSize: audioBlob.size,
        roundTripMs,
        error: err.message
      });
      
      // Clear all busy flags on error (including autoTTSPlaying to prevent UI block)
      busyRef.current.isProcessing = false;
      busyRef.current.autoTTSPlaying = false;
      if (err.name === 'AbortError') {
        console.log('Request cancelled');
        return;
      }
      
      // Track consecutive failures for encoder corruption detection
      if (err.message.includes('STT failed') || err.message.includes('could not be decoded') || err.message.includes('Invalid data found')) {
        consecutiveFailuresRef.current += 1;
        wavSuccessCountRef.current = 0; // Reset WAV success counter on failure
        console.warn(`⚠️ Consecutive failures: ${consecutiveFailuresRef.current} (mode: ${captureMode})`);
        
        // Switch to WAV mode after 2 consecutive failures in MP4 mode
        if (consecutiveFailuresRef.current >= 2 && captureMode === 'mp4') {
          console.log('🔄 MODE SWITCH: MP4 → WAV (consecutive failures:', consecutiveFailuresRef.current, ')');
          setCaptureMode('wav');
          wavSuccessCountRef.current = 0; // Reset WAV counter when switching
          setError('Switched to backup audio mode. Please try recording again.');
        } else if (captureMode === 'wav') {
          setError('Audio processing issue. Please try recording again.');
        } else {
          setError('Audio quality issue detected. Please try recording again.');
        }
      } else if (err.message.includes('network') || err.message.includes('fetch')) {
        setError('Network issue. Check your connection and try again.');
      } else {
        setError('Error processing audio. Please try again.');
      }
    } finally {
      // ALWAYS clear processing flags, regardless of operation ID
      // (autoTTSPlaying cleared by onQueueComplete callback if auto-play started)
      setIsProcessing(false);
      busyRef.current.isRecording = false;
      busyRef.current.isProcessing = false;
      // Note: autoTTSPlaying intentionally NOT cleared here - onQueueComplete handles it
      abortControllerRef.current = null;
    }
  }, [messages, captureMode]);

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
    
    // ALWAYS reveal translation (this is just state update, not audio)
    if (messageId) {
      setClickedBubbles(prev => new Set(prev.add(messageId)));
      
      // Fetch translation if not cached
      if (!translations.has(messageId)) {
        const translation = await translateText(text);
        if (translation) {
          setTranslations(prev => new Map(prev.set(messageId, translation)));
        }
      }
    }
    
    // Prime audio if needed (after resume or autoplay block)
    if (needsAudioPrimeRef.current.pending) {
      console.log('🔑 Priming audio from user gesture (bubble tap)');
      try {
        await ttsManager.prime();
        needsAudioPrimeRef.current = { pending: false, lastMsgId: null };
        console.log('✅ Audio primed from gesture');
      } catch (e) {
        console.warn('⚠️ Prime from gesture failed:', e.message);
      }
    }
    
    // Lifecycle guard - block audio if app needs resume (translation already shown)
    if (appLifecycle !== 'ready') {
      console.log('[lifecycle] Blocking speak() audio, state =', appLifecycle);
      return;
    }
    
    // Guard: Block AUDIO playback when busy, but translation still shows
    const b = busyRef.current;
    if (b.isRecording || b.isProcessing || b.autoTTSPlaying) {
      console.log('🚫 Audio blocked (busy), translation shown:', {
        isRecording: b.isRecording,
        isProcessing: b.isProcessing,
        autoTTSPlaying: b.autoTTSPlaying,
        messageId
      });
      return;
    }
    
    console.log('🔊 Speak:', messageId);
    
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
          const cacheResult = ttsCache.set(messageId, blob);
          
          if (cacheResult.isTemp) {
            // Temp URL - not cached
            console.log('🎵 Using temp URL for:', messageId);
            ttsManager.enqueueBlob(messageId, cacheResult.url, false);
          } else {
            // Cached URL
            ttsManager.enqueueBlob(messageId, cacheResult.url, true);
          }
        }
      }
    } catch (err) {
      console.error('TTS error:', err);
    }
  }, [translations, translateText, appLifecycle]);

  const clearConversation = useCallback(() => {
    const initialMessage = {
      role: "assistant", 
      correction_es: null,
      reply_es: "¡Hola! 😊 Soy tu tutor de español. Dime tu nombre y cómo te sientes hoy.", 
      needs_correction: false 
    };
    setMessages([initialMessage]);
    setError('');
    setTranslations(new Map());
    setClickedBubbles(new Set());
    ttsCache.clear();
    localStorage.removeItem('chatMessages');
    needsAudioPrimeRef.current = { pending: false, lastMsgId: null };
    consecutiveFailuresRef.current = 0;
    wavSuccessCountRef.current = 0;
    setCaptureMode('mp4'); // Reset to MP4 mode
    console.log('🔄 Conversation cleared - reset to MP4 mode');
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

      {/* Resume Banner - shown when returning from background */}
      {appLifecycle === 'needs-resume' && (
        <div style={{
          position: 'fixed',
          top: 'max(20px, env(safe-area-inset-top))',
          left: '16px',
          right: '16px',
          zIndex: 9998,
          backgroundColor: '#f59e0b',
          borderRadius: '16px',
          padding: '16px 20px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '16px', fontWeight: '600', color: 'white', marginBottom: '4px' }}>
              🔄 Resume Required
            </div>
            <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.9)' }}>
              Tap to restart audio after backgrounding
            </div>
          </div>
          <button
            onClick={resetAudioStack}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: '600',
              color: '#f59e0b',
              backgroundColor: 'white',
              border: 'none',
              borderRadius: '12px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.target.style.transform = 'scale(1.05)';
            }}
            onMouseLeave={(e) => {
              e.target.style.transform = 'scale(1)';
            }}
          >
            Resume
          </button>
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
