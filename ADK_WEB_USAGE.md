# ADK Web Agent Testing UI - Usage Guide

## Quick Answer: Does editing instructions affect production code?

**NO** - Editing agent instructions in the web UI does NOT change your production code. 

### How it works:
- The web UI creates a **temporary test agent** just for that specific test
- Your production code (in `adkScraper.js`) uses the **default instruction** hardcoded in the file
- Changes in the UI only affect that one test - nothing is saved to code
- This is perfect for **prompt engineering** - test different prompts without deploying code changes

## How to Use the Agent Testing UI

### Access the UI
Visit: `https://distroblog.onrender.com/agent-test`

### Basic Usage

1. **Enter a Website URL**
   - In the bottom input area, type the URL of the website you want to test
   - Example: `https://example.com` or `https://rendernetwork.medium.com`

2. **Send the Test**
   - Click the send button (✈️) or press Enter
   - The agent will use Google Search to find articles from that website

3. **View Results**
   - **Right Panel (Chat)**: See the conversation and articles found
   - **Left Panel (Events)**: See detailed function calls and agent actions

### Advanced: Edit Agent Instructions

1. **Expand Prompt Editor**
   - Click "Edit Agent Instruction (Advanced)" in the input area
   - This expands a textarea with the current default instruction

2. **Modify the Prompt**
   - Edit the instruction text to change how the agent behaves
   - Example changes:
     - Change number of articles: "exactly 3" → "exactly 5"
     - Add filtering rules
     - Modify output format requirements
     - Change language or tone

3. **Test Your Changes**
   - Enter a URL and click Send
   - The agent will use YOUR custom instruction (not the default)
   - Compare results to see if your prompt improvements work

4. **Iterate**
   - Try different prompts
   - Compare results side-by-side
   - When you find a good prompt, you can update the production code manually

### Understanding the Interface

**Left Panel - Events Tab:**
- Shows chronological log of agent actions
- **User** messages (green) - your requests
- **FUNCTION_CALL** (orange) - when agent calls Google Search
- **function_response** (blue) - Google Search results
- **Agent** responses (purple) - final agent output

**Right Panel - Chat:**
- Interactive conversation interface
- Shows user messages and agent responses
- Displays found articles as cards
- Shows function calls as special bubbles

**Other Tabs:**
- **Artifacts**: View articles found in the current session
- **Runs/Sessions/Eval**: Placeholder for future features

### Tips for Prompt Engineering

1. **Start Simple**: Test with the default instruction first to see baseline behavior

2. **Make Incremental Changes**: Change one thing at a time to see what affects results

3. **Compare Results**: Test the same URL with different prompts to see differences

4. **Use Specific Rules**: Be very specific about what you want
   - Instead of: "Find articles"
   - Use: "Find exactly 3 articles with URLs at least 11 characters long, excluding /about and /contact pages"

5. **When You Find a Good Prompt**:
   - Copy the instruction text
   - Update the instruction in `server/services/adkScraper.js` (line ~82)
   - Commit and push to deploy to production

### Example Workflow

1. Visit `/agent-test`
2. Enter URL: `https://rendernetwork.medium.com`
3. Expand "Edit Agent Instruction"
4. Change "exactly 3" to "exactly 5 articles"
5. Send test
6. Compare results - does it find 5 articles now?
7. If yes, update production code with this instruction
8. If no, try different wording and test again

### Important Notes

- **Temporary**: All changes are temporary - nothing is saved
- **No Impact on Production**: Your production agent is not affected by UI changes
- **Rate Limiting**: Google API has rate limits (10 requests per minute), so wait between tests
- **Session Management**: Click "+ New Session" to start fresh with a new conversation
