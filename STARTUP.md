# Distro Scoopstream Server Startup

## Quick Start (Recommended)

### Method 1: Use the startup script
```bash
./start-server.sh
```

### Method 2: Direct Node.js (if bash has issues)
```bash
node server/index.js
```

### Method 3: NPM start (if bash works)
```bash
npm start
```

## Server Details
- **Port**: 3001
- **Health Check**: http://localhost:3001/api/health
- **Environment**: Development
- **Database**: SQLite (./data/distroblog.db)

## Troubleshooting
If you get bash syntax errors, use Method 2 (direct Node.js) as it bypasses shell issues.

## API Endpoints
- `GET /api/health` - Server health check
- `GET /api/sources` - List RSS sources
- `GET /api/articles/new` - Get new articles
- `POST /api/sources` - Add new RSS source
- `DELETE /api/sources/:id` - Remove RSS source

