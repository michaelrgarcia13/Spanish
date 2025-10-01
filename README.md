# Spanish Language Learning App

A comprehensive Spanish tutoring app with speech recognition, AI chat, and text-to-speech functionality, optimized for iPhone/mobile use.

## Features

- 🎤 **Voice Recognition**: Press-and-hold recording optimized for mobile
- 🤖 **AI Tutor**: Latin American Spanish corrections and conversation
- 🔊 **Text-to-Speech**: Browser and server TTS options
- 📱 **Mobile Ready**: Works great on iPhone Safari with HTTPS
- 🎯 **Beginner Focused**: A1-A2 level Spanish learning

## Architecture

- **Frontend**: React + Vite + Tailwind CSS
- **Backend**: Node.js + Express + OpenAI API
- **Speech**: WebRTC recording + OpenAI Whisper
- **Chat**: OpenAI GPT with Spanish tutor system prompt
- **TTS**: OpenAI TTS + Browser Speech Synthesis fallback

## Quick Start (Local Development)

### 1. Backend Setup

```bash
cd spanish-kiosk-server
npm install
```

Create `.env` file with your OpenAI API key:
```
OPENAI_API_KEY=sk-your-openai-api-key-here
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_STT_MODEL=whisper-1
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=alloy
PORT=3000
```

Start the server:
```bash
npm start
```

### 2. Frontend Setup

```bash
cd spanish-kiosk-react
npm install
npm run dev
```

Visit `http://localhost:5173` to test locally.

## Deployment

### Backend (Requires HTTPS for iPhone)

Deploy to any platform that provides HTTPS:
- **Render**: Easy Node.js deployment
- **Railway**: Fast deployment with git integration  
- **Fly.io**: Global edge deployment
- **Heroku**: Classic platform option

Set environment variables in your platform dashboard.

### Frontend (Static Site)

Build and deploy:
```bash
cd spanish-kiosk-react
npm run build
```

Deploy `dist/` folder to:
- **Vercel**: Automatic deployments
- **Netlify**: Drag-and-drop or git integration
- **Cloudflare Pages**: Fast global CDN

Before deploying, update `index.html` with your backend URL:
```javascript
window.__API_BASE__ = "https://your-backend.example.com";
```

## iPhone Usage

1. Open Safari and navigate to your deployed frontend URL
2. Allow microphone permission when prompted
3. Add to Home Screen for app-like experience
4. Hold the mic button, speak Spanish, release to get corrections

## Project Structure

```
spanish-kiosk-server/
├── server.js           # Express backend with OpenAI integration
├── package.json        # Backend dependencies
└── .env               # API keys and configuration

spanish-kiosk-react/
├── src/
│   ├── App.jsx        # Main React component
│   ├── main.jsx       # React entry point
│   └── index.css      # Tailwind CSS imports
├── index.html         # HTML template with API config
├── package.json       # Frontend dependencies
├── tailwind.config.js # Tailwind configuration
└── vite.config.js     # Vite build configuration
```

## API Endpoints

- `POST /chat` - Send conversation messages, get Spanish tutor response
- `POST /stt` - Upload audio file, get Spanish transcription  
- `POST /tts` - Send text, get Spanish audio response

## OpenAI API Usage

- **Chat**: GPT-4o-mini for conversational Spanish tutoring
- **STT**: Whisper for Spanish speech recognition
- **TTS**: OpenAI TTS with Spanish voice for pronunciation

## Mobile Considerations

- **HTTPS Required**: iPhone microphone only works with secure origins
- **Audio Context**: App handles iOS audio autoplay restrictions
- **Touch Events**: Press-and-hold works with both mouse and touch
- **PWA Ready**: Can be installed as a home screen app

## Development Notes

- Backend uses ES modules (`"type": "module"`)
- Frontend configured for mobile-first responsive design
- Tailwind CSS for consistent styling across devices
- Error handling for network issues and API failures
- Graceful fallbacks for TTS and voice recognition

## License

MIT License - feel free to modify and deploy for personal or educational use.
