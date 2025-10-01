# Setup Instructions

## Prerequisites

1. **Node.js**: Install Node.js LTS from [nodejs.org](https://nodejs.org/)
2. **OpenAI API Key**: Get your API key from [platform.openai.com](https://platform.openai.com/api-keys)
3. **VS Code**: Install Visual Studio Code (optional but recommended)

## Getting Started

### 1. Set up your OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/api-keys)
2. Sign in or create an account
3. Click "Create new secret key"
4. Copy the key (starts with `sk-`)
5. Edit `spanish-kiosk-server/.env` and replace `sk-your-openai-api-key-here` with your actual key

### 2. Run the Application

**Option A: Using VS Code Tasks (Recommended)**
1. Open this folder in VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type "Tasks: Run Task"
4. Select "Start Both Servers"

**Option B: Manual Terminal Commands**

Backend:
```bash
cd spanish-kiosk-server
npm start
```

Frontend (in a new terminal):
```bash
cd spanish-kiosk-react
npm run dev
```

### 3. Test Locally

1. Open http://localhost:5173 in your browser
2. Allow microphone permissions
3. Hold the microphone button and speak in Spanish
4. You should see your transcript and get a response with corrections

**Note for iPhone Testing:**
- iPhone requires HTTPS for microphone access
- Local testing won't work on iPhone - you need to deploy to test mobile functionality

## Deployment

### Backend Deployment (Requires HTTPS)

**Option 1: Render (Recommended)**
1. Go to [render.com](https://render.com) and create account
2. Connect your GitHub repository
3. Create a new "Web Service"
4. Set build command: `cd spanish-kiosk-server && npm install`
5. Set start command: `cd spanish-kiosk-server && npm start`
6. Add environment variables:
   - `OPENAI_API_KEY=sk-your-key-here`
   - `OPENAI_CHAT_MODEL=gpt-4o-mini`
   - `OPENAI_STT_MODEL=whisper-1`
   - `OPENAI_TTS_MODEL=tts-1`
   - `OPENAI_TTS_VOICE=alloy`
7. Deploy and note your HTTPS URL

**Option 2: Railway**
1. Go to [railway.app](https://railway.app)
2. Deploy from GitHub
3. Add environment variables in dashboard
4. Get your HTTPS URL

### Frontend Deployment

**Option 1: Vercel (Recommended)**
1. Build the frontend: `cd spanish-kiosk-react && npm run build`
2. Update `index.html` before building:
   ```javascript
   window.__API_BASE__ = "https://your-backend-url.onrender.com";
   ```
3. Go to [vercel.com](https://vercel.com)
4. Import your project or drag the `dist` folder
5. Deploy and get your HTTPS URL

**Option 2: Netlify**
1. Build: `cd spanish-kiosk-react && npm run build`
2. Go to [netlify.com](https://netlify.com)
3. Drag the `dist` folder to deploy
4. Get your HTTPS URL

### iPhone Setup
1. Open Safari on iPhone
2. Go to your frontend URL (https://...)
3. Allow microphone permission
4. Tap Share → "Add to Home Screen"
5. Open from home screen for full-screen app experience

## Troubleshooting

### "OpenAI API Error"
- Check that your API key is correctly set in `spanish-kiosk-server/.env`
- Ensure you have credits in your OpenAI account

### "Microphone not working"
- Make sure you allowed microphone permissions
- Try refreshing the page and allowing permissions again
- On iPhone, this only works with HTTPS (deployed version)

### "Cannot connect to backend"
- Make sure the backend server is running on port 3000
- Check the browser console for network errors
