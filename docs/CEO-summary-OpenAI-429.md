# Check Now / OpenAI 429 – Summary for leadership

**What’s happening**  
When we run “Check Now,” we see errors like: *“Error generating article hook: 429 You exceeded your current quota, please check your plan and billing details.”* The feed check itself still completes (e.g. 37/39 sources, 164 new articles), but our system tries to generate a short “hook” for each new article using OpenAI’s API, and those calls are being rejected.

**Cause**  
The 429 comes from **OpenAI (ChatGPT API)**, not from our own scraping or ADK. We call OpenAI once per new article to generate that one-line hook. So when many articles are found in one run, we send many requests in a short time.

**Why it’s happening (possible reasons)**  
1. **Quota / billing** – The message says “quota” and “billing,” which usually means the OpenAI account has hit its **usage limit** (e.g. no credits left or over the plan’s limit).  
2. **Rate limit** – Sending a lot of hook requests in a short burst can also hit OpenAI’s **requests-per-minute** limit.  
3. **Combination** – We might be both near/over quota and sending requests too quickly.

**What we’re doing**  
- We’ve added **retries with backoff** for hook generation: on 429/quota we wait and retry a few times instead of failing immediately, and we fall back to a non-OpenAI hook when we still can’t get a response.  
- We’re **not blocking** the rest of Check Now on hooks: articles are still discovered and stored; only the optional AI-generated hook is affected when the limit is hit.

**What you might need to do**  
- Check **OpenAI usage and billing** (dashboard) and add credits or upgrade the plan if we’re over quota.  
- If the account is fine, the retries we added should help with temporary rate limits.
