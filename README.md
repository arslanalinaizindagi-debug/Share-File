# Live Text Sync Website

## What it does
Open this website in two browsers or two tabs. When you type or paste text in one window, the same text appears in the other in real-time.

## Run locally
1. Install dependencies:
   npm install
2. Start server:
   npm start
3. Open:
   http://localhost:3000

Now open the same URL in 2 different browsers (for example Chrome and Edge).

## Notes
- Uses WebSocket for instant sync.
- The latest text is kept in server memory while server is running.
