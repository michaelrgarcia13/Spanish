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
function Section({ label, text, onSpeak }) {
  if (!text) return null;
  return (
    <div
      className="rounded-2xl px-3 py-2 leading-relaxed shadow self-start bg-white/10 backdrop-blur-sm text-white ring-1 ring-white/20 select-none cursor-pointer hover:bg-white/15 transition-colors"
      onClick={() => onSpeak(text)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSpeak(text)}
    >
      {label ? <div className="text-xs text-blue-200 mb-1 font-medium">{label}</div> : null}
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}

function UserBubble({ text }) {
  return (
    <div className="max-w-[90%] rounded-2xl px-3 py-2 leading-relaxed shadow self-end bg-blue-600 text-white select-none">
      {text}
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

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

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

      // Auto-speak the main content (reply + question), not the ack/correction by default
      const toSpeak = [data.reply_es, data.question_es].filter(Boolean).join(' ');
      if (toSpeak) {
        if (useServerTTS) {
          await speakServerTTS(toSpeak, API_BASE);
        } else {
          await speakBrowserSpanish(toSpeak);
        }
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
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 text-white">
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">🇲🇽 Práctica de Español</h1>
          <p className="text-blue-200">Tutor de conversación latinoamericano</p>
        </header>

        {/* Controls */}
        <div className="bg-white/10 backdrop-blur-md rounded-lg p-6 mb-6">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={useServerTTS}
                  onChange={(e) => setUseServerTTS(e.target.checked)}
                  className="h-4 w-4 rounded"
                />
                <span>Usar TTS del servidor</span>
                <span className="text-blue-300 text-xs">ⓘ</span>
              </label>
              
              <button
                onClick={clearConversation}
                className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-xs transition-colors"
              >
                Limpiar
              </button>
            </div>
            
            <label className="flex items-center gap-2 text-xs select-none cursor-pointer">
              <input
                type="checkbox"
                checked={showEnglish}
                onChange={(e) => setShowEnglish(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span>Mostrar traducción en inglés</span>
            </label>
          </div>

          {/* Recording Button */}
          <div className="text-center">
            <button
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              disabled={isProcessing}
              className={`
                w-32 h-32 rounded-full text-4xl transition-all duration-200 transform
                ${isRecording 
                  ? 'bg-red-500 scale-110 animate-pulse' 
                  : 'bg-green-500 hover:bg-green-400 hover:scale-105'
                }
                ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                shadow-lg active:scale-95
              `}
            >
              {isProcessing ? '⌛' : isRecording ? '🔴' : '🎙️'}
            </button>
            
            <p className="mt-4 text-sm text-blue-200">
              {isProcessing 
                ? 'Procesando...' 
                : isRecording 
                  ? 'Grabando... (suelta para enviar)'
                  : 'Mantén presionado para hablar'
              }
            </p>
          </div>

          {/* Current Transcript */}
          {transcript && (
            <div className="mt-4 p-3 bg-blue-500/20 rounded-lg">
              <p className="text-sm text-blue-200 mb-1">Tu dijiste:</p>
              <p className="text-white">{transcript}</p>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="mt-4 p-3 bg-red-500/20 rounded-lg border border-red-500/30">
              <p className="text-red-200 text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Conversation History */}
        <div className="space-y-4">
          {messages.map((message, index) => {
            if (message.role === 'user') {
              return <UserBubble key={index} text={message.text} />;
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
        </div>

        {/* Instructions */}
        {messages.length === 0 && (
          <div className="mt-8 text-center text-blue-200">
            <h3 className="text-lg font-semibold mb-2">¿Cómo funciona?</h3>
            <ul className="text-sm space-y-1 max-w-md mx-auto">
              <li>1. Mantén presionado el micrófono</li>
              <li>2. Habla en español</li>
              <li>3. Suelta para enviar</li>
              <li>4. Recibe corrección + pregunta</li>
              <li>5. Escucha la respuesta</li>
            </ul>
            <p className="mt-4 text-xs opacity-75">
              Funciona mejor con frases completas y audio claro
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
