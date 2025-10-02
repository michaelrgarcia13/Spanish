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
function Section({ label, text, onSpeak, isUser = false }) {
  if (!text) return null;
  
  const baseClasses = "max-w-[85%] rounded-2xl px-4 py-3 leading-relaxed shadow-lg select-none cursor-pointer transition-all duration-200 hover:shadow-xl";
  const userClasses = "self-end bg-blue-500 text-white hover:bg-blue-600";
  const assistantClasses = "self-start bg-gray-100 text-gray-800 hover:bg-gray-200";
  
  return (
    <div
      className={`${baseClasses} ${isUser ? userClasses : assistantClasses}`}
      onClick={() => onSpeak(text)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSpeak(text)}
    >
      {label && !isUser ? <div className="text-xs text-gray-500 mb-1 font-medium uppercase tracking-wide">{label}</div> : null}
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}

function UserBubble({ text, onSpeak }) {
  return (
    <Section text={text} onSpeak={onSpeak} isUser={true} />
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

  const startRecording = useCallback(async () => {
    try {
      setError('');
      
      // Prime TTS on first user interaction
      await primeTTSGesture();

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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await processAudio(audioBlob);
        
        // Clean up stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      setError('Error accessing microphone: ' + err.message);
      console.error('Recording error:', err);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

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

      // Auto-speak the main content (reply + question) with better mobile support
      const toSpeak = [data.reply_es, data.question_es].filter(Boolean).join(' ');
      if (toSpeak) {
        // Add a small delay to ensure the UI updates first, then speak
        setTimeout(async () => {
          try {
            if (useServerTTS) {
              await speakServerTTS(toSpeak, API_BASE);
            } else {
              await speakBrowserSpanish(toSpeak);
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
    <div className="h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm border-b px-4 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-800">🇲🇽 Práctica de Español</h1>
          </div>
          <div className="flex items-center gap-4">
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

      {/* Chat Messages Container - Scrollable */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col gap-3">
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return <UserBubble key={index} text={message.text} onSpeak={speak} />;
              }

              return (
                <div key={index} className="flex flex-col gap-2">
                  <Section text={message.ack_es} onSpeak={speak} />
                  {message.correction_es && (
                    <Section 
                      label="Corrección" 
                      text={message.correction_es} 
                      onSpeak={speak} 
                    />
                  )}
                  <Section text={message.reply_es} onSpeak={speak} />
                  <Section text={message.question_es} onSpeak={speak} />
                  {showEnglish && message.translation_en && (
                    <Section 
                      label="English" 
                      text={message.translation_en} 
                      onSpeak={async (text) => await speakServerTTS(text, API_BASE)} 
                    />
                  )}
                </div>
              );
            })}
            {/* Invisible element to scroll to */}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {/* Current Status/Error Bar */}
      {(transcript || error) && (
        <div className="bg-white border-t px-4 py-2 flex-shrink-0">
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

      {/* Bottom Microphone Button */}
      <div className="bg-white border-t px-4 py-6 flex-shrink-0">
        <div className="max-w-4xl mx-auto text-center">
          <button
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            disabled={isProcessing}
            className={`
              w-24 h-24 rounded-full text-6xl transition-all duration-200 transform shadow-xl
              ${isRecording 
                ? 'bg-red-500 scale-110 animate-pulse shadow-red-500/50' 
                : 'bg-blue-500 hover:bg-blue-600 hover:scale-105 shadow-blue-500/30'
              }
              ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              active:scale-95 text-white
            `}
          >
            {isProcessing ? '⌛' : isRecording ? '⏹️' : '🎙️'}
          </button>
          
          <p className="mt-3 text-sm text-gray-600">
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
