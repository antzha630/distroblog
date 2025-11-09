# Supabase Database Setup for Render

## The Problem
Your `render.yaml` was still pointing to the old Render database (`distroblog-db`) which no longer exists. You need to update the `DATABASE_URL` environment variable in Render to point to your Supabase database.

## Step 1: Get Your Supabase Connection String

1. Go to [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to **Settings** → **Database**
4. Scroll down to **Connection string**
5. Select **Connection pooling** (Transaction mode)
6. Copy the connection string - it should look like:
   ```
   postgresql://postgres.fwikafkqhwxqusniiqzk:[YOUR-PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres
   ```

## Step 2: Update DATABASE_URL in Render

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click on your **distroblog** web service
3. Go to **Environment** tab
4. Find the `DATABASE_URL` environment variable
5. Click **Edit** or **Add** if it doesn't exist
6. Paste your Supabase connection string
7. **Important**: Make sure to URL-encode your password if it contains special characters:
   - `@` → `%40`
   - `#` → `%23`
   - `$` → `%24`
   - `%` → `%25`
   - etc.
8. Click **Save Changes**
9. Render will automatically redeploy your service

## Step 3: Verify Connection

After redeploy, check the logs to see if the database connection succeeds:
- Should see: `PostgreSQL connected successfully`
- Should NOT see: `ENOTFOUND dpg-d3hk250gjchc73aicttg-a`

## Connection String Format

### For Render (External Connection) - Use Pooler:
```
postgresql://postgres.fwikafkqhwxqusniiqzk:[PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres
```
- Port: **6543** (connection pooler)
- Host: `aws-1-us-east-1.pooler.supabase.com`
- Username: `postgres.fwikafkqhwxqusniiqzk`

### For Local Development - Use Direct Connection:
```
postgresql://postgres:[PASSWORD]@db.fwikafkqhwxqusniiqzk.supabase.co:5432/postgres
```
- Port: **5432** (direct connection)
- Host: `db.fwikafkqhwxqusniiqzk.supabase.co`
- Username: `postgres`

## Troubleshooting

### If connection fails:
1. **Check password encoding**: Make sure special characters are URL-encoded
2. **Check port**: Use port 6543 for Render (pooler), not 5432
3. **Check hostname**: Should be `pooler.supabase.com` not `db.supabase.co`
4. **Reset password**: If password has many special characters, reset it in Supabase to a simpler one

### Common Errors:
- `ENOTFOUND`: Wrong hostname or database doesn't exist
- `password authentication failed`: Wrong password or not URL-encoded
- `connection timeout`: Wrong port (should be 6543 for pooler)

## After Setup

Once the `DATABASE_URL` is correctly set in Render:
1. Your service will automatically redeploy
2. Database connection should succeed
3. Tables will be created automatically
4. Your app will start successfully

