# LocalShare – Multi-Stream WebSocket File Transfer
LocalShare is a real-time file transfer web app built with **Django Channels** and **WebSockets**. It enables fast peer-to-peer style transfers by splitting files into **multiple parallel streams** and sending them concurrently. Designed mainly for **LAN / group-based usage**.

---

## Features
- Pure WebSocket communication (no HTTP uploads)
- Multi-stream parallel file transfer
- Chunked binary streaming (Blob / ArrayBuffer)
- Real-time online user discovery
- Send / Accept / Cancel transfer flow
- Live download progress, speed & ETA
- Automatic file reassembly & validation
- Graceful transfer cancellation
- Backpressure handling using `bufferedAmount`

---

## Tech Stack
**Backend:** Django, Django Channels, ASGI, WebSockets  
**Frontend:** Vanilla JavaScript, WebSocket API, Tailwind CSS + DaisyUI

---

## Architecture
Each user maintains:  
- **1 Control WebSocket**: user discovery, transfer request/response, start/end signals  
- **N Data WebSockets (default: 4)**: parallel binary file streaming
Sender
├── Control WS
├── Data WS #1 ──►
├── Data WS #2 ──► Receiver
├── Data WS #3 ──►
└── Data WS #4 ──►
---

## File Transfer Flow
1. Users join a group  
2. Online users discovered in real time  
3. Sender sends a transfer request  
4. Receiver accepts the request  
5. File is split into N segments  
6. Segments stream in parallel  
7. Receiver reassembles chunks  
8. File is auto-downloaded  
9. Transfer completes or is canceled

---

## Configuration
**Frontend**
```js
const NUM_STREAMS = 4;
const CHUNK_SIZE = 128 * 1024; // 128 KB

**Backend Groups**
- file-transfer-group-{group_id}
- user-control-{user_id}
- user-data-{user_id}-stream-{stream_id}

## Running the Project
pip install django channels
python manage.py migrate
python manage.py runserver

License
Distributed under the MIT License. See LICENSE for more information.