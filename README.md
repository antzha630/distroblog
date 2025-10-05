# Distro Scoopstream - News Monitoring for Journalists

An AI-enhanced news monitoring tool that helps journalists track updates from multiple RSS sources, summarize content using LLM, and prepare articles for distribution.

## Features

- **RSS Feed Monitoring**: Automatically checks multiple news sources for updates
- **AI Summarization**: Uses OpenAI GPT to create concise, fact-focused summaries
- **Editorial Workflow**: Review → Edit → Send workflow designed for journalists
- **Duplicate Detection**: Prevents the same article from being processed twice
- **Source Management**: Easy addition and monitoring of RSS feeds
- **JSON Output**: Generates structured data for publishing systems

## Quick Start

### 1. Setup Environment

```bash
# Clone and setup
cd distro-scoopstream
cp env.example .env

# Edit .env and add your OpenAI API key
# OPENAI_API_KEY=your_api_key_here
```

### 2. Install Dependencies

```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd client && npm install && cd ..
```

### 3. Run the Application

```bash
# Start both backend and frontend
npm run dev
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## Architecture

### Backend (Node.js/Express)
- **RSS Parser**: Monitors feeds every 15 minutes
- **SQLite Database**: Stores sources, articles, and status
- **OpenAI Integration**: Summarizes articles with fact-checking prompts
- **REST API**: Serves data to frontend

### Frontend (React)
- **Dashboard**: Review new articles and select for editing
- **Editor**: Side-by-side editing interface
- **Send Confirmation**: Final review and JSON generation
- **Source Manager**: Add and monitor RSS feeds

## Workflow

1. **Configuration** (one-time):
   - Add RSS feed URLs in the Sources section
   - System validates feeds and begins monitoring

2. **Daily Use**:
   - Open dashboard to see new articles
   - Review AI-generated summaries
   - Select articles worth distributing
   - Edit headlines and content as needed
   - Generate JSON payload for your publishing system

## API Endpoints

### Sources
- `GET /api/sources` - List all monitored sources
- `POST /api/sources` - Add new RSS source

### Articles
- `GET /api/articles/new` - Get unreviewed articles
- `GET /api/articles/selected` - Get articles selected for editing
- `POST /api/articles/review` - Mark articles as selected/dismissed
- `PUT /api/articles/:id` - Update article content
- `POST /api/articles/send` - Generate JSON payload

### Monitoring
- `POST /api/monitor/trigger` - Manually trigger feed check
- `GET /api/health` - System health check

## JSON Output Format

The system generates JSON in this format for each article:

```json
{
  "user_info": {
    "name": "Reporter Name"
  },
  "more_info_url": "https://source.com/article",
  "source": "Source Name",
  "cost": "free",
  "preview": "Brief preview text...",
  "title": "Article Headline",
  "content": "Full article content..."
}
```

## Configuration

### Environment Variables
- `OPENAI_API_KEY`: Your OpenAI API key for summarization
- `PORT`: Server port (default: 3001)
- `DB_PATH`: SQLite database location (default: ./data/distro-scoopstream.db)

### LLM Settings
The system uses conservative prompts designed for factual accuracy:
- Temperature: 0.1 (low for consistency)
- Max tokens: 200 per summary
- Fallback: Simple text truncation if OpenAI unavailable

## Production Deployment

### Docker Setup
```bash
# Build and run
docker build -t distro-scoopstream .
docker run -p 3001:3001 -e OPENAI_API_KEY=your_key distro-scoopstream
```

### Manual Deployment
1. Set `NODE_ENV=production`
2. Build frontend: `cd client && npm run build`
3. Start server: `npm start`
4. Use process manager like PM2 for reliability

## Development

### Adding New Features
- Backend routes: `server/index.js`
- RSS monitoring: `server/services/feedMonitor.js`
- LLM integration: `server/services/llmService.js`
- Database: `server/database.js`
- Frontend components: `client/src/components/`

### Testing RSS Feeds
Use the manual trigger button in the UI or call:
```bash
curl -X POST http://localhost:3001/api/monitor/trigger
```

### Database Schema
- `sources`: RSS feed configurations
- `articles`: Parsed articles with status tracking

## Troubleshooting

### Common Issues

**RSS feed not working:**
- Verify the URL is a direct RSS/XML feed
- Check source success rate in Sources page
- Some sites block automated requests

**OpenAI errors:**
- Verify API key is correct
- Check account has sufficient credits
- System falls back to text truncation if LLM fails

**No new articles:**
- Sources may not have published recently
- Check feed monitoring logs in server console
- Use manual trigger to test

### Support
For technical issues or feature requests, check the server logs and ensure all dependencies are properly installed.

## License

MIT License - see LICENSE file for details.