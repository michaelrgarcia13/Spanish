import React, { useState, useRef, useCallback, useEffect } from 'react';

// Get API base URL from window or default to localhost for development
const API_BASE = window.__API_BASE__ || 'http://localhost:3000';

function App() {
  const [messages, setMessages] = useState([]);
  const [transcript, setTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [useServerTTS, setUseServerTTS] = useState(false);
  const [error, setError] = useState('');

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

  // iOS Safari requires user interaction before audio can play
  const [audioEnabled, setAudioEnabled] = useState(false);

  const enableAudio = useCallback(async () => {
    try {
      // Play a silent audio to enable autoplay on iOS
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = audioContext.createBuffer(1, 1, 22050);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start();
      setAudioEnabled(true);
    } catch (e) {
      console.log('Audio context setup failed:', e);
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setError('');
      
      // Enable audio on first user interaction
      if (!audioEnabled) {
        await enableAudio();
      }

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
  }, [audioEnabled, enableAudio]);

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
      const newUserMessage = { role: 'user', content: userText };
      const updatedMessages = [...messages, newUserMessage];
      setMessages(updatedMessages);

      // Send to chat
      const chatResponse = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      if (!chatResponse.ok) {
        throw new Error(`Chat failed: ${chatResponse.status}`);
      }

      const chatData = await chatResponse.json();
      const botReply = chatData.reply || 'Lo siento, no pude generar una respuesta.';

      // Add bot message
      const newBotMessage = { role: 'assistant', content: botReply };
      setMessages([...updatedMessages, newBotMessage]);

      // Play TTS
      if (useServerTTS) {
        await playServerTTS(botReply);
      } else {
        await playBrowserTTS(botReply);
      }

    } catch (err) {
      console.error('Full processing error:', err);
      setError('Error processing audio: ' + err.message);
    } finally {
      setIsProcessing(false);
    }
  }, [messages, useServerTTS]);

  const playServerTTS = useCallback(async (text) => {
    try {
      const response = await fetch(`${API_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (response.ok) {
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        
        audio.onended = () => URL.revokeObjectURL(audioUrl);
        await audio.play();
      }
    } catch (err) {
      console.error('Server TTS error:', err);
      // Fallback to browser TTS
      await playBrowserTTS(text);
    }
  }, []);

  const playBrowserTTS = useCallback(async (text) => {
    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();
      
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-MX'; // Mexican Spanish
      utterance.rate = 0.8;
      utterance.pitch = 1;
      
      // Try to find a Spanish voice
      const voices = window.speechSynthesis.getVoices();
      const spanishVoice = voices.find(voice => 
        voice.lang.startsWith('es') && voice.name.includes('Google')
      ) || voices.find(voice => voice.lang.startsWith('es'));
      
      if (spanishVoice) {
        utterance.voice = spanishVoice;
      }
      
      window.speechSynthesis.speak(utterance);
    }
  }, []);

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
          <div className="flex items-center justify-between mb-4">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useServerTTS}
                onChange={(e) => setUseServerTTS(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm">Usar TTS del servidor</span>
            </label>
            
            <button
              onClick={clearConversation}
              className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-sm transition-colors"
            >
              Limpiar
            </button>
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
          {messages.map((message, index) => (
            <div
              key={index}
              className={`p-4 rounded-lg ${
                message.role === 'user'
                  ? 'bg-blue-500/20 ml-8'
                  : 'bg-green-500/20 mr-8'
              }`}
            >
              <div className="flex items-center mb-2">
                <span className="text-sm font-semibold">
                  {message.role === 'user' ? '🗣️ Tú' : '🤖 Tutor'}
                </span>
              </div>
              <p className="whitespace-pre-wrap">{message.content}</p>
            </div>
          ))}
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
