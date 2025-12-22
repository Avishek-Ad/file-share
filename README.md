# FileShare – Multi-Stream WebSocket File Transfer
FileShare is a real-time file transfer web app built with **Django Channels** and **WebSockets**. It enables fast peer-to-peer style transfers by splitting files into **multiple parallel streams** and sending them concurrently. Designed mainly for **group-based usage**.

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
- **a Control WebSocket**: user discovery, transfer request/response, start/end signals 
- **a Data WebSockets **: binary file streaming

```text
Sender
├── Control WS
└── Data WS ──► Receiver
```

## File Transfer Flow
1. Users join a group  
2. Online users discovered in real time  
3. Sender sends a transfer request  
4. Receiver accepts the request  
5. File is split into N chunks  
7. Receiver reassembles chunks  
8. File is auto-downloaded  through file system api
9. Transfer completes or is canceled

---

## Running the Project
```py
pip install django channels
python manage.py migrate
python manage.py runserver
```

## License

Distributed under the MIT License. See LICENSE for more information.