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

## Current Status
- ✅ Code committed to git
- ⏳ Needs GitHub repository
- ⏳ Needs backend deployment
- ⏳ Needs frontend deployment
- ⏳ Needs iPhone testing
