# Live Text Sync Website

## What it does
Open this website in two browsers or two tabs. Room-based text, notes, code, and file sharing syncs across devices.

## Runtime
This project now uses PHP backend polling and file-based room storage.

## Local run (PHP)
1. Serve the `public` folder with PHP:
   `php -S localhost:8000 -t public`
2. Open:
   `http://localhost:8000`

## Notes
- API endpoint is `public/api.php`.
- Room state is persisted in `public/storage/rooms.json`.
- WebSocket/Node legacy files have been removed.
