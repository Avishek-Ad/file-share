const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const URL_ws = `${protocol}://${window.location.host}/ws/transfer/local`

// Global State
let ws_control, ws_data;
let myid, receiver_id, sender_id;
let file_handle, writable, file_to_transfer;

// Transfer Metrics
let write_offset = 0;
let received_filename = '';
let incoming_filesize = 0;
let transfer_start_time;
let total_received_bytes = 0;
let last_ui_update_time = 0;
let is_transfer_active = false;

// Flow Control
let target_bps = 2 * 512 * 1024; // Start at 1MB/s
let last_send_time = 0;
let window_start = 0;
let bytes_since_window = 0;
let queued_buffer = 0;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20MB
let feedback_timer = null;

async function init() {
    myid = Math.floor(Math.random() * 1000000);
    document.getElementById('sub-title').innerHTML = `Online users [myid=${myid}]`;
    document.getElementById('all-users').innerHTML = 'No users found';

    await establish_ws_connection();
    setup_ui_listeners();
    // Initialize the default state of the confirm container
    reset_confirm_or_deny_container_content(); 
}

function setup_ui_listeners() {
    const send_button = document.getElementById('send-file-button');
    const hide_container_button = document.getElementById('hide-container-button');

    hide_container_button.addEventListener('click', () => {
        document.getElementById('container').classList.add('hidden');
        send_button.classList.remove('hidden');
    });

    send_button.addEventListener('click', () => {
        const fileInput = document.getElementById('file-choosen');
        file_to_transfer = fileInput.files[0];

        if (!file_to_transfer) {
            fileInput.classList.add('border-2', 'border-error', 'animate-shake');
            setTimeout(() => fileInput.classList.remove('border-2', 'border-error', 'animate-shake'), 2000);
            return;
        }

        ws_control.send(JSON.stringify({
            'type': 'request',
            'sender_id': myid,
            'receiver_id': receiver_id,
            'filename': file_to_transfer.name,
            'filesize': file_to_transfer.size,
        }));

        toggle_send_button_loading(true, "awaiting accept....");
    });
}

function toggle_send_button_loading(isLoading, text) {
    const btn = document.getElementById('send-file-button');
    btn.disabled = isLoading;

    if (isLoading) {
        btn.classList.remove('btn-primary', 'shadow-primary/20');
        btn.classList.add('bg-slate-800/50', 'text-slate-400', 'border-white/5', 'cursor-not-allowed');
        
        btn.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="loading loading-spinner loading-xs"></span>
                <span class="font-mono text-[11px] uppercase tracking-widest">${text}</span>
            </div>`;
    } else {
        btn.classList.add('text-white', 'btn-primary', 'shadow-lg', 'shadow-primary/20');
        btn.classList.remove('bg-slate-800/50', 'text-slate-500', 'border-white/5', 'cursor-not-allowed', 'bg-ghost');
        
        btn.innerHTML = `<span class="uppercase font-bold tracking-tight">${text}</span>`;
    }
}

function attach_confirm_buttons_listeners() {
    // Re-query elements as they might have been re-injected by reset_confirm_or_deny_container_content
    const receive_cancel = document.getElementById('receive-cancel-button');
    const receive_accept = document.getElementById('receive-accept-button');

    if(receive_cancel) {
        receive_cancel.addEventListener('click', () => {
             hide_card('confirm-or-deny');
             // Optional: Send rejection message here
             const sender_id_val = document.getElementById('sender-id-show').innerHTML;
             ws_control.send(JSON.stringify({
                'type': 'response_cancel',
                'sender_id': sender_id_val,
                'receiver_id': myid
             }))
        });
    }

    if(receive_accept) {
        receive_accept.addEventListener('click', async () => {
            await prepare_file_handle();
            const sender_id_val = document.getElementById('sender-id-show').innerHTML;
            
            ws_control.send(JSON.stringify({
                'type': 'response',
                'sender_id': sender_id_val,
                'receiver_id': myid
            }));
            hide_card('confirm-or-deny');
        });
    }
}

async function prepare_file_handle() {
    try {
        file_handle = await window.showSaveFilePicker({ suggestedName: received_filename });
        writable = await file_handle.createWritable();
    } catch (err) {
        console.error("File picker cancelled or failed", err);
    }
}

// --- Feedback & Flow Control ---

function start_feedback_loop() {
    if (feedback_timer) clearInterval(feedback_timer);
    window_start = performance.now();
    bytes_since_window = 0;
    
    feedback_timer = setInterval(() => {
        const now = performance.now();
        const duration_sec = (now - window_start) / 1000;
        if (duration_sec <= 0) return;

        const bps = bytes_since_window / duration_sec;
        const b_level = Math.min(queued_buffer / MAX_BUFFER_BYTES, 1);
        
        // console.log("FEEDBACK bps, b_level", bps, b_level)

        if (bytes_since_window > 0) {
            send_feedback_flow_control(bps, b_level);
        }

        window_start = now;
        bytes_since_window = 0;
    }, 200);
}

function stop_feedback_loop() {
    clearInterval(feedback_timer);
    feedback_timer = null;
}

function send_feedback_flow_control(bps, b_level) {
    if (ws_control?.readyState === WebSocket.OPEN) {
        ws_control.send(JSON.stringify({
            'type': 'flow_control',
            'sender_id': sender_id,
            'download_bps': bps,
            'buffer_level': b_level,
        }));
    }
}

// --- WebSocket Setup ---
async function establish_ws_connection() {
    ws_control = new WebSocket(`${URL_ws}/?myid=${myid}&purpose=control`);
    await setup_control_listeners(ws_control);

    ws_data = new WebSocket(`${URL_ws}/?myid=${myid}&purpose=data`);
    setup_stream_websocket_listeners(ws_data);
}

async function setup_control_listeners(ws) {
    ws.onopen = () => console.log(`Control Websocket connected.`);
    ws.onclose = () => {
        console.log(`Control websocket disconnected`);
        stop_feedback_loop();
        reset_transfer_state();
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.online_users) handle_online_users(data.online_users);
        
        if (data.type === 'request') {
            received_filename = data.filename;
            incoming_filesize = data.filesize;
            sender_id = data.sender_id;
            handle_confirm_or_deny(data.sender_id);
        }
        
        if (data.type === 'response') {
            await streaming_file_multi_ws_server();
        }

        if (data.type === 'response_cancel') {
            console.log("Received ignored")
            toggle_send_button_loading(false, "Initiate Transfer")
        }
        
        if (data.type === 'transfer_start') {
            console.log(`FILE RECEIVE STARTED`);
            transfer_start_time = performance.now();
            total_received_bytes = 0;
            is_transfer_active = true;
            queued_buffer = 0;
            
            start_feedback_loop();
            show_download_progress();
        }
        
        if (data.type === 'transfer_cancel') {
            document.getElementById('download-status').innerHTML = `<span class="font-bold text-md text-red-400">Canceled by User-${data['sender_id']}</span>`;
            reset_transfer_state(10000); 
        }

        if (data.type === "flow_control" && myid === data.sender_id) {
            handle_flow_control_update(data);
        }
    };
}

function handle_flow_control_update(data) {
    const reported_bps = data.download_bps;
    const buffer_level = data.buffer_level;

    let new_target = reported_bps * 1.5; // Aiming slightly higher than current speed

    if (buffer_level >= 0.8) {
        // Slow down if receiver buffer is high
        target_bps = Math.min(target_bps, new_target);
    } else {
        // Ramp up
        target_bps = new_target;
    }
    // Set a safe floor
    target_bps = Math.max(target_bps, 256 * 1024);
}

function setup_stream_websocket_listeners(ws) {
    ws.onmessage = async (event) => {
        if (!is_transfer_active || !(event.data instanceof Blob || event.data instanceof ArrayBuffer)) return;

        const buffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        const chunkSize = buffer.byteLength;

        // Metrics update
        bytes_since_window += chunkSize;
        queued_buffer += chunkSize;
        total_received_bytes += chunkSize;

        // Disk Write
        const write_position = write_offset;
        write_offset += chunkSize;
        
        try {
            await writable.write({ type: 'write', position: write_position, data: buffer });
            queued_buffer -= chunkSize;
        } catch (error) {
            console.error("Disk write error", error);
            is_transfer_active = false;
        }

        // UI Update (Throttled)
        const now = performance.now();
        if (now - last_ui_update_time > 100) {
            update_progress_ui(now);
            last_ui_update_time = now;
        }

        if (total_received_bytes === incoming_filesize) {
            console.log("Download complete.");
            setTimeout(reassemble_and_download, 100);
        }
    };
}

// Logic Helpers
function update_progress_ui(now) {
    const progress = Math.min((total_received_bytes / incoming_filesize) * 100, 100);
    const duration_seconds = (now - transfer_start_time) / 1000;
    const speed_mbps = (total_received_bytes / (1024 * 1024)) / duration_seconds;
    
    // Avoid divide by zero for ETA
    const eta = speed_mbps > 0 ? ((incoming_filesize - total_received_bytes) / (1024 * 1024)) / speed_mbps : 0;

    const progressEl = document.getElementById('download-progress');
    const statusEl = document.getElementById('download-status');

    if (progressEl) {
        progressEl.value = progress;
        statusEl.innerText = `Downloading... ${progress.toFixed(1)}% (${speed_mbps.toFixed(2)} MB/s) - ${eta.toFixed(0)}s left`;
    }
}

async function streaming_file_multi_ws_server() {
    is_transfer_active = true;
    update_sender_ui_start();

    const file_size = file_to_transfer.size;
    const CHUNK_SIZE = 64 * 1024; 
    const MAXIMUM_BUFFER_SIZE = 4 * 1024 * 1024;

    ws_control.send(JSON.stringify({ 'type': "transfer_start", 'receiver_id': receiver_id }));

    let offset = 0;
    
    while (offset < file_size) {
        if (!is_transfer_active) break;

        // Backpressure check
        if (ws_data.bufferedAmount > MAXIMUM_BUFFER_SIZE) {
            await new Promise(r => setTimeout(r, 10));
            continue;
        }

        const chunk = file_to_transfer.slice(offset, Math.min(offset + CHUNK_SIZE, file_size));
        const buffer = await chunk.arrayBuffer();

        await paceSend(buffer.byteLength);
        
        ws_data.send(buffer);
        offset += CHUNK_SIZE;
    }

    // Flush remaining buffer
    while (ws_data.bufferedAmount > 0) {
        await new Promise(r => setTimeout(r, 50));
    }

    ws_control.send(JSON.stringify({
        'type': "transfer_end",
        'receiver_id': receiver_id,
        'total_received': file_to_transfer.size
    }));

    update_sender_ui_success();
}

async function paceSend(chunk_size) {
    if (!isFinite(target_bps)) return;
    target_bps = Math.max(target_bps, 64 * 1024);

    const now = performance.now();
    const min_interval = (chunk_size / target_bps) * 1000;
    const elapsed = now - (last_send_time || 0);

    if (elapsed < min_interval) {
        await new Promise(r => setTimeout(r, min_interval - elapsed));
    }
    last_send_time = performance.now();
}

async function reassemble_and_download() {
    is_transfer_active = false;
    stop_feedback_loop();
    await writable.close();
    
    const statusEl = document.getElementById('download-status');
    if (statusEl) statusEl.innerText = 'Download complete ✔';
    
    reset_transfer_state(5000);
}

// UI Management
function reset_transfer_state(delay = 0) {
    is_transfer_active = false;
    stop_feedback_loop();
    total_received_bytes = 0;
    
    setTimeout(() => {
        reset_confirm_or_deny_container_content();
        hide_card('confirm-or-deny');
    }, delay);
}

function update_sender_ui_start() {
    const btn = document.getElementById('send-file-button');
    // We remove the default btn-primary to allow for a custom 'active' look
    btn.classList.add('bg-slate-700/50'); 
    
    btn.innerHTML = `
         <div class="flex items-center gap-3 px-1">
            <span class="loading loading-ring loading-sm text-primary"></span>
            <div class="flex flex-col items-start leading-none">
                <span class="text-[10px] uppercase tracking-widest text-primary font-bold">UPLOADING</span>
                <span class="text-[11px] text-slate-200 font-mono truncate max-w-30">
                    ${file_to_transfer.name}
                </span>
            </div>
        </div>`;
}

function update_sender_ui_success() {
    const btn = document.getElementById('send-file-button');
    // Switch to success styling
    btn.classList.remove('btn-primary', 'bg-slate-700/50');
    btn.classList.add('btn-success', 'text-white');
    
    btn.innerHTML = `
        <div class="flex items-center justify-center gap-2">
            <div class="bg-white/20 rounded-full p-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7" />
                </svg>
            </div>
            <span class="text-xs font-bold uppercase tracking-tighter">Transfer Complete</span>
        </div>`;
    
    setTimeout(() => {
        // Reset button appearance before reverting text
        btn.classList.remove('btn-success', 'text-white');
        btn.classList.add('btn-primary');
        toggle_send_button_loading(false, 'Initiate Transfer');
    }, 1200);
}

function handle_online_users(users) {
    if (users.length <= 1) {
        document.getElementById('container').classList.add('hidden');
        document.getElementById('all-users').innerHTML = 'No users found';
        return;
    }
    
    const ul_element = document.getElementById('all-users');
    ul_element.innerHTML = ''; // Clear list
    
    users.forEach((user_id) => {
        if (user_id != myid) {
            const li = document.createElement('li');
            li.innerHTML = `
                <div class="flex items-center justify-between p-3 rounded-xl bg-slate-900/40 border border-white/5 group-hover:border-primary/50 group-hover:bg-slate-800/60 transition-all duration-200">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center border border-white/10 group-hover:bg-primary group-hover:text-white transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                        </div>
                        <div class="flex flex-col">
                            <span class="text-sm font-mono font-bold text-slate-200">NODE-${user_id}</span>
                            <span class="text-[10px] text-slate-500 uppercase tracking-tighter">Latency: --ms</span>
                        </div>
                    </div>
                    <span class="badge badge-success badge-xs shadow-[0_0_8px_rgba(34,197,94,0.4)]"></span>
                </div>
            `;
            li.id = `user-${user_id}`;
            li.classList.add("select-none");
            li.addEventListener('click', () => handle_user_clicked(user_id));
            ul_element.appendChild(li);
        }
    });
}

function handle_user_clicked(user_id) {
    receiver_id = user_id;
    show_card('container');
    const title = document.getElementById('container-title');
    title.innerHTML = `user-${user_id}`;
    title.classList.add('text-primary', 'tracking-wide');
}

function handle_confirm_or_deny(sender_id) {
    // Only update the sender ID text, don't destroy the whole container
    document.getElementById('sender-id-show').innerHTML = sender_id;
    show_card('confirm-or-deny');
}

function show_download_progress() {
    let container = document.getElementById('confirm-or-deny');
    // Using the same glassmorphism and padding as the main cards
    container.innerHTML = `
        <div class="card-body p-6 gap-5">
            <div class="flex items-center justify-between">
                <span class="text-xs font-bold uppercase tracking-widest text-primary">Transferring Data</span>
                <span class="loading loading-spinner loading-xs text-primary"></span>
            </div>

            <progress 
                id="download-progress" 
                class="progress progress-primary w-full bg-slate-700 h-3" 
                value="0" 
                max="100"
            ></progress>

            <div class="flex flex-col gap-1">
                <p id="download-status" class="text-sm font-mono text-slate-300">
                    Initializing tunnel...
                </p>
                <div class="w-full bg-white/5 h-px my-1"></div>
                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-tighter">
                    Secure P2P Connection Active
                </p>
            </div>
        </div>`;
    show_card('confirm-or-deny');
}

function reset_confirm_or_deny_container_content() {
    let container = document.getElementById('confirm-or-deny');
    // Reverting to the "Incoming Signal" style with the specific node icon
    container.innerHTML = `
        <div class="card-body p-6 gap-6">
            <div class="flex items-center gap-4">
                <div class="p-3 bg-secondary/10 rounded-xl">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                </div>
                <div>
                    <h3 class="card-title text-white leading-tight">Incoming Data</h3>
                    <p class="text-xs text-slate-400">
                        Node <span class="font-mono text-secondary font-bold" id="sender-id-show"></span> is requesting a tunnel.
                    </p>
                </div>
            </div>

            <div class="flex justify-end gap-2">
                <button id="receive-cancel-button" class="btn btn-ghost btn-sm text-error hover:bg-error/10">
                    Ignore
                </button>
                <button id="receive-accept-button" class="btn btn-success btn-sm px-8 text-white shadow-lg shadow-success/20">
                    Accept
                </button>
            </div>
        </div>`;
    
    // Crucial: Re-attach the event listeners to the new buttons
    attach_confirm_buttons_listeners();
}
function show_card(id) {
    const el = document.getElementById(id);
    el.classList.remove('hidden');
    el.classList.add('animate-fade-in', 'animate-duration-200');
}

function hide_card(id) {
    document.getElementById(id).classList.add('hidden');
}

init();