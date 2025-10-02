# Deployment Guide for iPhone

## Quick Deploy Checklist

### Backend Deployment (Render - Free)
1. Go to [render.com](https://render.com) 
2. Sign up with GitHub
3. Create "New Web Service"
4. Connect your GitHub repo
5. Settings:
   - **Build Command**: `cd spanish-kiosk-server && npm install`
   - **Start Command**: `cd spanish-kiosk-server && npm start`
   - **Environment Variables**:
     ```
     OPENAI_API_KEY=your-actual-api-key-here
     OPENAI_CHAT_MODEL=gpt-4o-mini
     OPENAI_STT_MODEL=whisper-1
     OPENAI_TTS_MODEL=tts-1
     OPENAI_TTS_VOICE=alloy
     PORT=3000
     ```
6. Deploy → Copy the HTTPS URL (e.g. `https://spanish-app-xyz.onrender.com`)

### Frontend Deployment (Vercel - Free)
1. **FIRST**: Update the frontend with your backend URL
2. Go to [vercel.com](https://vercel.com)
3. Import your GitHub repository
4. Deploy automatically
5. Copy the HTTPS URL

### iPhone Setup
1. Open Safari on iPhone
2. Go to your Vercel URL
3. Allow microphone permission
4. Add to Home Screen for app experience

## ✅ DEPLOYMENT COMPLETE!

- ✅ Code committed to git
- ✅ Pushed to GitHub: https://github.com/michaelrgarcia13/Spanish
- ✅ Backend deployed to Render: https://spanish-xcs6.onrender.com
- ✅ Frontend deployed to Vercel: https://spanish-red.vercel.app/
- 🎯 Ready for iPhone testing!

## Live URLs
- **App**: https://spanish-red.vercel.app/
- **Backend API**: https://spanish-xcs6.onrender.com
- **GitHub**: https://github.com/michaelrgarcia13/Spanish

## iPhone Setup Instructions
1. Open Safari on iPhone
2. Go to: https://spanish-red.vercel.app/
3. Allow microphone permission when prompted
4. Test: Hold mic button, speak Spanish, release
5. Optional: Add to Home Screen for app-like experience

## App Features
- 🎤 Voice recognition (Spanish)
- 🤖 AI tutor with Latin American corrections
- 🔊 Text-to-speech responses (browser + server options)
- 📱 Mobile-optimized interface with tap-to-replay
- 🌍 Optional English translations
- 🚀 Works offline once loaded

## TTS Options Explained
**"Usar TTS del servidor" checkbox:**
- ❌ **Unchecked (Browser TTS)**: Uses your device's built-in voices (free, faster, but quality varies by device)
- ✅ **Checked (Server TTS)**: Uses OpenAI's premium voices (consistent quality, slight delay, small API cost)
- 💡 **iPhone tip**: Server TTS often works better on mobile devices
