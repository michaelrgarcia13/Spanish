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
function MessageBubble({ text, isUser, label, onSpeak }) {
  if (!text) return null;
  
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 px-2`}>
      <div className={`max-w-[80%] ${isUser ? 'ml-8' : 'mr-8'}`}>
        {label && !isUser && (
          <div className="text-xs text-gray-500 mb-1 font-medium uppercase tracking-wide px-2">
            {label}
          </div>
        )}
        <div
          className={`
            px-4 py-3 shadow-md transition-all duration-200
            ${isUser 
              ? 'bg-blue-500 text-white rounded-2xl rounded-br-md' 
              : 'bg-gray-200 text-gray-800 rounded-2xl rounded-bl-md'
            }
            hover:shadow-lg
          `}
          onDoubleClick={(e) => {
            // Only trigger speak if no text is selected
            const selection = window.getSelection();
            if (!selection || selection.toString().length === 0) {
              onSpeak(text);
            }
          }}
          title="Double-click to speak aloud (if no text selected)"
        >
          <div className="whitespace-pre-wrap leading-relaxed text-sm md:text-base">
            {text}
          </div>
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
  
  const [transcript, setTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [useServerTTS, setUseServerTTS] = useState(isiOS); // Default ON for iOS
  const [showEnglish, setShowEnglish] = useState(false);
  const [error, setError] = useState('');
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [permissionRequested, setPermissionRequested] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const messagesEndRef = useRef(null);

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
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (mediaRecorderRef.current) {
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

  const requestMicPermissionOnce = useCallback(async () => {
    if (permissionRequested) return;
    
    try {
      setPermissionRequested(true);
      console.log('Requesting microphone permission...');
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      
      // Stop the test stream immediately
      stream.getTracks().forEach(track => track.stop());
      
      // Store permission in localStorage
      localStorage.setItem('micPermissionGranted', 'true');
      setMicPermissionGranted(true);
      console.log('Microphone permission granted and stored');
      
    } catch (err) {
      console.error('Microphone permission denied:', err);
      setError('Microphone permission denied. Please enable it in your browser settings.');
      setPermissionRequested(false);
    }
  }, [permissionRequested]);

  const startRecording = useCallback(async (e) => {
    // Prevent default behavior and stop event propagation
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Prevent starting if already recording or processing
    if (isRecording || isProcessing) {
      console.log('Already recording or processing, ignoring start request');
      return;
    }

    // Request permission if not granted yet
    if (!micPermissionGranted) {
      console.log('Requesting microphone permission first...');
      await requestMicPermissionOnce();
      if (!micPermissionGranted) return; // Permission was denied
    }

    console.log('Starting recording...');
    
    try {
      setError('');
      
      // Prime TTS on first user interaction
      await primeTTSGesture();

      // Request a fresh stream for this recording session
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });

      streamRef.current = stream;
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('MediaRecorder stopped, processing audio...');
        
        // Clean up the stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
        
        // Process the audio if we have data
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          await processAudio(audioBlob);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
      console.log('Recording started');
      
    } catch (err) {
      setError('Error starting recording: ' + err.message);
      setIsRecording(false);
      console.error('Recording error:', err);
    }
  }, [isRecording, isProcessing, micPermissionGranted, requestMicPermissionOnce]);

  const stopRecording = useCallback((e) => {
    // Prevent default behavior and stop event propagation
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    console.log('Stopping recording...');
    
    if (!isRecording) {
      console.log('Not recording, ignoring stop request');
      return;
    }
    
    setIsRecording(false);
    
    // Stop the media recorder if it's recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      console.log('Stopping MediaRecorder');
      mediaRecorderRef.current.stop();
    }
  }, [isRecording]);

  const processAudio = useCallback(async (audioBlob) => {
    setIsProcessing(true);
    
    try {
      // Send to speech-to-text
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');

      const sttResponse = await fetch(`${API_BASE}/stt`, {
        method: 'POST',
        body: formData,
      });

      if (!sttResponse.ok) {
        throw new Error(`STT failed: ${sttResponse.status}`);
      }

      const sttData = await sttResponse.json();
      const userText = sttData.text || '';
      setTranscript(userText);

      if (!userText.trim()) {
        setError('No speech detected. Try speaking louder or closer to the microphone.');
        return;
      }

      // Add user message
      const newUserMessage = { role: 'user', text: userText };
      setMessages(prev => [...prev, newUserMessage]);

      // Convert to simple format for backend
      const simpleHistory = [...messages, { role: 'user', content: userText }].map(msg => ({
        role: msg.role,
        content: msg.text || msg.content || [msg.ack_es, msg.reply_es, msg.question_es].filter(Boolean).join(' ')
      }));

      // Send to chat with translation flag
      const chatResponse = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: simpleHistory, 
          translate: showEnglish 
        }),
      });

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

      setMessages(prev => [...prev, assistantMessage]);

      // Auto-speak ALL parts of the AI response (ack, correction, reply, question)
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
      setError('Error processing audio: ' + err.message);
    } finally {
      setIsProcessing(false);
    }
  }, [messages, useServerTTS, showEnglish]);

  // Speak function for tap-to-read sections
  const speak = useCallback(async (text) => {
    if (useServerTTS) {
      await speakServerTTS(text, API_BASE);
    } else {
      await speakBrowserSpanish(text);
    }
  }, [useServerTTS]);

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
    setTranscript('');
    setError('');
  }, []);

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* Header - Fixed Height */}
      <header className="bg-white shadow-sm border-b px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-800">🇲🇽 Práctica de Español</h1>
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
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 bg-gradient-to-b from-white to-gray-50">
        <div className="max-w-4xl mx-auto h-full">
          <div className="space-y-2">
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <MessageBubble 
                    key={`user-${index}`} 
                    text={message.text} 
                    isUser={true}
                    onSpeak={speak} 
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
                    />
                  )}
                  {message.correction_es && (
                    <MessageBubble 
                      text={message.correction_es} 
                      isUser={false}
                      label="Corrección"
                      onSpeak={speak} 
                    />
                  )}
                  {message.reply_es && (
                    <MessageBubble 
                      text={message.reply_es} 
                      isUser={false}
                      onSpeak={speak} 
                    />
                  )}
                  {message.question_es && (
                    <MessageBubble 
                      text={message.question_es} 
                      isUser={false}
                      onSpeak={speak} 
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

      {/* Status/Error Bar - Fixed Height (when visible) */}
      {(transcript || error) && (
        <div className="bg-white border-t px-4 py-2 shrink-0">
          {transcript && (
            <div className="max-w-4xl mx-auto">
              <p className="text-sm text-gray-600">You said: <span className="text-gray-800 font-medium">{transcript}</span></p>
            </div>
          )}
          {error && (
            <div className="max-w-4xl mx-auto">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}
        </div>
      )}

      {/* Bottom Microphone Button - Fixed Height */}
      <div className="bg-white border-t px-4 py-6 shrink-0">
        <div className="max-w-4xl mx-auto text-center">
          <button
            onMouseDown={(e) => startRecording(e)}
            onMouseUp={(e) => stopRecording(e)}
            onMouseLeave={(e) => isRecording && stopRecording(e)}
            onTouchStart={(e) => startRecording(e)}
            onTouchEnd={(e) => stopRecording(e)}
            onTouchCancel={(e) => isRecording && stopRecording(e)}
            disabled={isProcessing}
            className={`
              mic-button w-40 h-16 rounded-full text-4xl transition-all duration-200 transform shadow-xl
              ${isRecording 
                ? 'bg-red-500 scale-105 animate-pulse shadow-red-500/50' 
                : 'bg-blue-500 hover:bg-blue-600 hover:scale-105 shadow-blue-500/30'
              }
              ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              active:scale-95 text-white font-medium
            `}
          >
            {isProcessing ? '⌛' : isRecording ? '⏹️' : '🎙️'}
          </button>
          
          <p className="mt-2 text-sm text-gray-600">
            {isProcessing 
              ? 'Processing...' 
              : isRecording 
                ? 'Recording... (release to send)'
                : 'Hold to speak in Spanish'
            }
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
