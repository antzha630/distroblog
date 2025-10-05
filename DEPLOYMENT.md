# Deployment Guide

## Quick Deploy to Render (Recommended)

### Step 1: Create Render Account
1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Connect your GitHub account

### Step 2: Prepare Your Repository
1. Push your code to GitHub
2. Make sure your `package.json` has these scripts:
   ```json
   {
     "scripts": {
       "start": "node server/index.js",
       "build": "cd client && npm run build"
     }
   }
   ```

### Step 3: Deploy on Render
1. Go to Render Dashboard → "New" → "Web Service"
2. Connect your GitHub repository
3. Configure the service:
   - **Name**: `distroblog` (or whatever you want)
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Plan**: Choose "Starter" ($7/month) or "Standard" ($25/month)

### Step 4: Set Environment Variables
In Render dashboard, go to your service → "Environment":
- `NODE_ENV=production`
- `REACT_APP_API_BASE_URL=https://your-app-name.onrender.com` (replace with your actual URL)

### Step 5: Deploy
1. Click "Create Web Service"
2. Wait for build to complete (5-10 minutes)
3. Your app will be live at `https://your-app-name.onrender.com`

## How It Works

- **Server runs 24/7**: Unlike Vercel, Render keeps your Node.js server running continuously
- **SQLite database**: Stored on Render's persistent disk (survives restarts)
- **Background processes**: Your feed monitoring runs automatically
- **Static files**: React build is served by your Node.js server

## Cost
- **Starter Plan**: $7/month (768MB RAM, 0.1 CPU)
- **Standard Plan**: $25/month (2GB RAM, 1 CPU) - recommended for production

## Alternative: Railway
Railway is another option with similar pricing:
1. Go to [railway.app](https://railway.app)
2. Connect GitHub
3. Deploy with same configuration

## Troubleshooting
- If build fails, check the logs in Render dashboard
- Make sure all dependencies are in `package.json`
- Environment variables must be set correctly
- Database will be created automatically on first run
