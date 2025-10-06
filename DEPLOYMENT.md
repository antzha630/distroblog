# Deployment Guide - Free Tier with PostgreSQL

## Quick Deploy to Render (Free Tier)

### Step 1: Create Render Account
1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Connect your GitHub account

### Step 2: Deploy with Blueprint
1. Go to Render Dashboard → "New" → "Blueprint"
2. Connect your GitHub repository
3. Select the `render.yaml` file
4. Click "Apply"

### Step 3: What Gets Created
- **Web Service**: Free tier (sleeps after 15 minutes)
- **PostgreSQL Database**: Free tier (always available)
- **Environment Variables**: Automatically configured

### Step 4: Set Your OpenAI API Key
1. Go to your web service dashboard
2. Navigate to "Environment"
3. Add: `OPENAI_API_KEY=your_actual_api_key_here`

## How It Works

- **Web Service**: Free tier - sleeps after 15 minutes of inactivity
- **PostgreSQL Database**: Free tier - always available
- **Manual Feed Checks**: Users click "Check Now" to refresh articles
- **30-second wake-up**: When someone visits after 15 minutes of inactivity

## Cost
- **Total**: $0/month (completely free!)
- **Web Service**: Free (with sleep limitations)
- **PostgreSQL**: Free (1GB storage)

## Limitations
- **No automatic feed monitoring** (background processes don't work on free tier)
- **30-second wake-up time** when service sleeps
- **Manual refresh required** for new articles

## For Production (Optional Upgrade)
If you need automatic feed monitoring:
- **Web Service**: Upgrade to Starter ($7/month)
- **PostgreSQL**: Keep free tier
- **Total**: $7/month

## Troubleshooting
- If build fails, check the logs in Render dashboard
- Make sure your OpenAI API key is set correctly
- Database will be created automatically on first run
- Check the "Logs" tab for any errors
