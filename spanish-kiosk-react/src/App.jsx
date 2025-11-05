import React, { useState, useRef, useCallback, useEffect } from 'react';

// Get API base URL from window or default to localhost for development
const API_BASE = window.__API_BASE__ || 'http://localhost:3000';

// ---- TTS Manager ----
let ttsPrimed = false;

function pickSpanishVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const prefs = ["es-MX","es-US","es-419","es-AR","es-CL","es-CO","es-PE","es-VE","es-UY","es-EC","es-CR","es-PA","es-PR","es-DO","es-HN","es-NI","es-SV","es-GT"];
  for (const tag of prefs) {
    const v = voices.find(v => v.lang?.toLowerCase() === tag.toLowerCase());
    if (v) return v;
  }
  return voices.find(v => v.lang?.toLowerCase().startsWith("es"));
}

async function primeTTSGesture() {
  // Call this on first user gesture (press mic). Helps iOS/ChromeOS.
  try {
    if (ttsPrimed) return;
    const dummy = new SpeechSynthesisUtterance(" ");
    dummy.volume = 0; // silent priming blip
    window.speechSynthesis?.speak(dummy);
    ttsPrimed = true;
  } catch {}
}

function speakBrowserSpanish(text) {
  // Small delay protects against immediate cancel/race on first utterance in some Chromes
  return new Promise((resolve) => {
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickSpanishVoice();
      if (v) u.voice = v;
      u.rate = 0.95; u.pitch = 1.0;
      u.onend = resolve;
      u.onerror = resolve;
      try { 
        window.speechSynthesis?.speak(u); 
      } catch { 
        resolve(); 
      }
    }, 60);
  });
}

async function speakServerTTS(text, apiBase) {
  try {
    const r = await fetch(`${apiBase}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch (e) {
    console.error('Server TTS error:', e);
  }
}

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
          onClick={() => onSpeak(text, messageId)}
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
  // Initialize with a structured greeting
  const [messages, setMessages] = useState([
    { 
      role: "assistant", 
      ack_es: "¡Hola! 😊 Soy tu tutor de español.", 
      reply_es: "Dime tu nombre y cómo te sientes hoy.", 
      question_es: "", 
      needs_correction: false 
    }
  ]);
  

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [useServerTTS, setUseServerTTS] = useState(isiOS); // Default ON for iOS
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
  const streamRef = useRef(null);
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null); // For canceling requests
  const recordingStartTimeRef = useRef(null); // Track recording duration

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

  // Check and store microphone permission status
  useEffect(() => {
    const checkPermission = async () => {
      try {
        // Check if permission was already granted before
        const storedPermission = localStorage.getItem('micPermissionGranted');
        if (storedPermission === 'true') {
          setMicPermissionGranted(true);
          console.log('Microphone permission already granted (from storage)');
          return;
        }

        // Try to check current permission status
        if (navigator.permissions) {
          const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
          if (permissionStatus.state === 'granted') {
            setMicPermissionGranted(true);
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
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          track.stop();
          console.log('Cleanup: stopped track', track.id);
        });
        streamRef.current = null;
      }
      if (mediaRecorderRef.current) {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current = null;
      }
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
      
      // Stop the test stream immediately and thoroughly clean up
      stream.getTracks().forEach(track => {
        track.stop();
        console.log('Stopped test microphone track:', track.id);
      });
      
      // Add a small delay to ensure cleanup on iOS
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Store permission in localStorage
      localStorage.setItem('micPermissionGranted', 'true');
      setMicPermissionGranted(true);
      console.log('Microphone permission granted and stored');
      
    } catch (err) {
      console.error('Microphone permission denied:', err);
      setError('Microphone permission denied. Please enable it in your browser settings.');
      setPermissionRequested(false);
    } finally {
      setIsRequestingPermission(false);
    }
  }, [permissionRequested, isRequestingPermission]);

  const handleButtonPress = useCallback(async (e) => {
    console.log('🎯 handleButtonPress called');
    
    // Prevent default behavior and stop event propagation
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    console.log('🎯 Current state:', {
      micPermissionGranted,
      isRecording,
      isProcessing,
      isRequestingPermission
    });

    // If permission not granted, request it but DON'T start recording yet
    if (!micPermissionGranted) {
      console.log('🎯 Microphone permission needed - requesting permission only');
      try {
        await requestMicPermissionOnce();
        console.log('🎯 Permission request completed - button ready for recording');
      } catch (err) {
        console.error('🎯 Permission request failed:', err);
      }
      return; // Exit - user must press button again to record
    }

    // If permission is granted, start recording immediately
    console.log('🎯 Permission granted, calling startRecording');
    return startRecording(e);
  }, [micPermissionGranted, requestMicPermissionOnce]);

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

    console.log('Starting recording with existing permission...');
    
    try {
      setError('');
      
      // Prime TTS on first user interaction
      await primeTTSGesture();

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

      streamRef.current = stream;
      audioChunksRef.current = [];

      // Try MIME types in order of OpenAI Whisper compatibility
      const mimeTypesToTry = [
        'audio/wav',           // Most compatible
        'audio/mp4',           // Very compatible
        'audio/webm',          // Compatible but less reliable
        'audio/ogg',           // Fallback
        'audio/webm;codecs=opus' // Last resort
      ];
      
      console.log('MediaRecorder MIME type support check:');
      mimeTypesToTry.forEach(type => {
        console.log(`  ${type}: ${MediaRecorder.isTypeSupported(type) ? '✅ Supported' : '❌ Not supported'}`);
      });
      
      let mimeType = '';
      for (const type of mimeTypesToTry) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          break;
        }
      }
      
      // If no specific type supported, let browser choose
      if (!mimeType) {
        mimeType = ''; 
        console.log('No preferred MIME type supported, using browser default');
      } else {
        console.log('Selected MIME type:', mimeType);
      }
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

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
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => {
              track.stop();
              console.log('Stopped recording track:', track.id, track.readyState);
            });
            streamRef.current = null;
          }
          mediaRecorderRef.current = null;
          
          await processAudio(audioBlob);
        } else {
          console.log('No audio data collected');
          setIsProcessing(false);
          setError('No audio recorded. Try speaking closer to the microphone.');
          
          // Clean up even if no data
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
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
      setIsRecording(true);
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
  }, [isRecording, isProcessing, micPermissionGranted]);

  const stopRecording = useCallback((e) => {
    // Prevent default behavior and stop event propagation
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    console.log('Stopping recording...');
    
    // If we're requesting permission, ignore stop recording
    if (isRequestingPermission) {
      console.log('Currently requesting permission, ignoring stop request');
      return;
    }
    
    if (!isRecording) {
      console.log('Not recording, ignoring stop request');
      return;
    }

    // Check minimum recording duration (500ms minimum to avoid "too short" errors)
    const recordingDuration = Date.now() - (recordingStartTimeRef.current || 0);
    console.log('Recording duration:', recordingDuration + 'ms');
    
    if (recordingDuration < 500) {
      console.log('Recording too short (' + recordingDuration + 'ms), extending to minimum duration...');
      // Wait a bit more before stopping to ensure minimum duration
      setTimeout(() => {
        if (isRecording) {
          console.log('Now stopping after minimum duration wait');
          stopRecording(e);
        }
      }, 500 - recordingDuration);
      return;
    }
    
    setIsRecording(false);
    
    // Stop the media recorder if it's recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      console.log('Stopping MediaRecorder');
      mediaRecorderRef.current.stop();
    }
    
    // Also immediately stop any active streams as backup
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        if (track.readyState === 'live') {
          track.stop();
          console.log('Force stopped active track:', track.id);
        }
      });
    }
  }, [isRecording, isRequestingPermission]);

  const processAudio = useCallback(async (audioBlob) => {
    setIsProcessing(true);
    setError(''); // Clear any previous errors
    
    console.log('Processing audio blob:', {
      size: audioBlob.size,
      type: audioBlob.type,
      lastModified: audioBlob.lastModified || 'N/A'
    });
    
    // Create abort controller for this request
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    
    try {
      // Send to speech-to-text
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');

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
        content: msg.text || msg.content || [msg.ack_es, msg.reply_es, msg.question_es].filter(Boolean).join(' ')
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
      
      // Add structured assistant response
      const assistantMessage = {
        role: 'assistant',
        ack_es: data.ack_es || '',
        correction_es: data.correction_es,
        reply_es: data.reply_es || '',
        question_es: data.question_es || '',
        translation_en: data.translation_en,
        needs_correction: !!data.needs_correction
      };

      // Pre-cache translations for instant display when bubbles are clicked
      setMessages(prev => {
        const newMessages = [...prev, assistantMessage];
        const assistantIndex = newMessages.length - 1;
        const userIndex = assistantIndex - 1;
        
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
          
          if (data.ack_es && data.translation_en.includes('acknowledgment:')) {
            const ackLine = data.translation_en.split('acknowledgment:')[1]?.split('\n')[0]?.trim();
            if (ackLine) {
              const ackTranslation = extractFromBrackets(ackLine);
              newTranslations.set(`assistant-${assistantIndex}-ack`, ackTranslation);
            }
          }
          if (data.correction_es && data.translation_en.includes('correction:')) {
            const correctionLine = data.translation_en.split('correction:')[1]?.split('\n')[0]?.trim();
            if (correctionLine) {
              const correctionTranslation = extractFromBrackets(correctionLine);
              newTranslations.set(`assistant-${assistantIndex}-correction`, correctionTranslation);
            }
          }
          if (data.reply_es && data.translation_en.includes('reply:')) {
            const replyLine = data.translation_en.split('reply:')[1]?.split('\n')[0]?.trim();
            if (replyLine) {
              const replyTranslation = extractFromBrackets(replyLine);
              newTranslations.set(`assistant-${assistantIndex}-reply`, replyTranslation);
            }
          }
          if (data.question_es && data.translation_en.includes('question:')) {
            const questionLine = data.translation_en.split('question:')[1]?.trim();
            if (questionLine) {
              const questionTranslation = extractFromBrackets(questionLine);
              newTranslations.set(`assistant-${assistantIndex}-question`, questionTranslation);
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

      // Auto-speak ALL parts of the AI response (ack, correction, reply, question)
      // Note: Mobile Safari blocks autoplay, so this only works on desktop or after user interaction
      const allParts = [
        data.ack_es,
        data.correction_es,
        data.reply_es,
        data.question_es
      ].filter(Boolean);
      
      if (allParts.length > 0) {
        // Add a small delay to ensure the UI updates first, then speak each part
        setTimeout(async () => {
          try {
            // Check if we're on mobile - if so, skip auto-TTS (iOS blocks autoplay)
            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            if (isMobile) {
              console.log('Mobile device detected - skipping auto-TTS (tap bubbles to hear audio)');
              return;
            }
            
            for (const part of allParts) {
              console.log('Speaking part:', part.substring(0, 50) + '...');
              if (useServerTTS) {
                await speakServerTTS(part, API_BASE);
              } else {
                await speakBrowserSpanish(part);
              }
              // Small pause between parts
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } catch (e) {
            console.log('Auto-TTS failed:', e);
          }
        }, 300);
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
  }, [messages, useServerTTS, showEnglish]);

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

  // Speak function for tap-to-read sections with instant translation display
  const speak = useCallback(async (text, messageId) => {
    console.log('🔊 Speaking:', { text, messageId, hasTranslation: translations.has(messageId) });
    
    // Mark this bubble as clicked to reveal translation
    if (messageId) {
      setClickedBubbles(prev => new Set(prev.add(messageId)));
    }
    
    // Play the TTS
    if (useServerTTS) {
      await speakServerTTS(text, API_BASE);
    } else {
      await speakBrowserSpanish(text);
    }
    
    // Translation should already be cached from chat response
    // If somehow not cached (shouldn't happen), get it as fallback
    if (messageId && !translations.has(messageId)) {
      console.log('⚠️ Translation not pre-cached for messageId:', messageId, '- fetching as fallback');
      const translation = await translateText(text);
      if (translation) {
        console.log('✅ Fallback translation received:', { messageId, translation });
        setTranslations(prev => new Map(prev.set(messageId, translation)));
      }
    } else if (messageId) {
      console.log('⚡ Using pre-cached translation for:', messageId);
    }
  }, [useServerTTS, translations, translateText]);

  // Load voices on component mount (needed for some browsers)
  useEffect(() => {
    if ('speechSynthesis' in window) {
      const loadVoices = () => window.speechSynthesis.getVoices();
      loadVoices();
      window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
      return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
    }
  }, []);

  const clearConversation = useCallback(() => {
    setMessages([]);
    setError('');
    setTranslations(new Map()); // Clear all translations
    setClickedBubbles(new Set()); // Clear clicked bubbles state
  }, []);

  return (
    <div className="h-full w-full bg-gray-50 flex flex-col overflow-hidden" style={{ height: '100vh', width: '100vw' }}>
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
                checked={useServerTTS}
                onChange={(e) => setUseServerTTS(e.target.checked)}
                className="h-3 w-3 rounded"
              />
              <span>Server TTS</span>
            </label>
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
                  {message.ack_es && (
                    <MessageBubble 
                      text={message.ack_es} 
                      isUser={false}
                      onSpeak={speak}
                      messageId={`assistant-${index}-ack`}
                      translation={translations.get(`assistant-${index}-ack`)}
                      hasBeenClicked={clickedBubbles.has(`assistant-${index}-ack`)} 
                    />
                  )}
                  {message.correction_es && (
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
            onMouseDown={(e) => {
              console.log('🖱️ MouseDown event fired');
              if (!isProcessing && !isRequestingPermission) {
                console.log('🖱️ MouseDown conditions met, calling handleButtonPress');
                handleButtonPress(e);
              } else {
                console.log('🖱️ MouseDown blocked:', { isProcessing, isRequestingPermission });
              }
            }}
            onMouseUp={(e) => {
              console.log('🖱️ MouseUp event fired');
              if (!isRequestingPermission) {
                console.log('🖱️ MouseUp calling stopRecording');
                stopRecording(e);
              } else {
                console.log('🖱️ MouseUp blocked:', { isRequestingPermission });
              }
            }}
            onMouseLeave={(e) => {
              console.log('🖱️ MouseLeave event fired');
              // Don't stop recording on mouse leave for desktop - only on mouse up
              // This prevents accidental stopping when cursor moves slightly during press
            }}
            onTouchStart={(e) => {
              console.log('📱 TouchStart event fired');
              if (!isProcessing && !isRequestingPermission) {
                console.log('📱 TouchStart conditions met, calling handleButtonPress');
                handleButtonPress(e);
              } else {
                console.log('📱 TouchStart blocked:', { isProcessing, isRequestingPermission });
              }
            }}
            onTouchEnd={(e) => {
              console.log('📱 TouchEnd event fired');
              if (!isRequestingPermission) {
                console.log('📱 TouchEnd calling stopRecording');
                stopRecording(e);
              } else {
                console.log('📱 TouchEnd blocked:', { isRequestingPermission });
              }
            }}
            onTouchCancel={(e) => {
              console.log('📱 TouchCancel event fired');
              // Only stop recording on touch cancel if actually recording
              if (isRecording && !isRequestingPermission) {
                console.log('📱 TouchCancel stopping recording');
                stopRecording(e);
              }
            }}
            onClick={(e) => {
              if (isProcessing) {
                cancelProcessing();
              }
            }}
            disabled={isRequestingPermission}
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
              opacity: isRequestingPermission ? 0.6 : 1
            }}
          >
            {isRequestingPermission ? '🔐' : isProcessing ? '✖️' : isRecording ? '⏹️' : '🎙️'}
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
