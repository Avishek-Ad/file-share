const URL_ws = `ws://${window.location.host}/ws/transfer`
const NUM_STREAMS = 4
let ws_control;
let ws_streams = []
let myid;
let receiver_id;
let streams_data = {}
let stream_completed = 0
let received_filename = '';
let incoming_filesize = 0;
let transfer_start_time;
let total_received_bytes = 0;
let last_ui_update_time = 0;
let is_transfer_active = false;

function init(){
    myid = Math.floor(Math.random() * 1000000)
    let div_container = document.getElementById('sub-title')
    div_container.innerHTML = `Online users [myid=${myid}]`
    document.getElementById('all-users').innerHTML = 'No users found'

    establish_ws_connection();

    const send_button = document.getElementById('send-file-button')
    const transfer_cancel_button = document.getElementById('transfer-cancel-button')
    const hide_container_button = document.getElementById('hide-container-button')
    const receive_cancel_button = document.getElementById('receive-cancel-button')
    const receive_accept_button = document.getElementById('receive-accept-button')
    const start_streaming_button = document.getElementById('start-stream-button')
    
    transfer_cancel_button.addEventListener('click', ()=> {
        // console.log("cancel transfer")
        is_transfer_active = false;
        if (receiver_id){
            ws_control.send(JSON.stringify({
                'type': 'transfer_cancel',
                'sender_id': myid,
                'receiver_id': receiver_id
            }))
        }
        reset_receive_state()

        // removing visual indicator
        const btn = document.getElementById('start-stream-button')
        btn.innerHTML = `
                <span class="text-xs font-semibold text-error">Cancled successfully</span>
        `

        // keep disabled briefly so user notices success
        setTimeout(() => {
            btn.disabled = false
            btn.classList.add('btn-primary')
            btn.classList.remove('btn-ghost')
            btn.innerHTML = 'Send File'
        }, 1200)

        // hide transfer cancel button and show div close button
        // hide_card('transfer-cancel-button')
        // show_card('hide-container-button')
    })

    hide_container_button.addEventListener('click', ()=> {
        // console.log("hide container")
        document.getElementById('container').classList.add('hidden');
        send_button.classList.remove('hidden')

    })

    receive_cancel_button.addEventListener('click', ()=> {
        // may be in the future send a signal to say i cancel
        document.getElementById('confirm-or-deny').classList.add('hidden');
    })

    send_button.addEventListener('click', ()=> {
        // console.log("Send button clicked")
        ws_control.send(
            JSON.stringify({
                'type': 'request',
                'sender_id':myid,
                'receiver_id': receiver_id
            })
        )
    })

    receive_accept_button.addEventListener('click', ()=> {
        let sender_id_span = document.getElementById('sender-id-show')
        // console.log("accept button clicked", sender_id_span.innerHTML)
        ws_control.send(
            JSON.stringify({
                'type': 'response',
                'sender_id': sender_id_span.innerHTML,
                'receiver_id': myid
            })
        )
        hide_card('confirm-or-deny')
    })

    start_streaming_button.addEventListener('click', streaming_file_multi_ws_server)
}

function establish_ws_connection(){
    const group_id = document.getElementById("group-id-span").innerText.trim();

    if (!group_id) {
        document.getElementById("sub-title").innerHTML = `
            <div class="text-center text-sm text-error">
                No group provided
                <a href="/" class="link link-error ml-2">Go back</a>
            </div>
        `;
        return;
    }
    ws_control = new WebSocket(URL_ws+`/?myid=${myid}&purpose=control&group_id=${group_id}`)
    setup_control_listners(ws_control)

    for (let i=0; i<NUM_STREAMS; i++){
        const stream_id = i+1;
        let ws = new WebSocket(URL_ws+`/?myid=${myid}&stream_id=${stream_id}&purpose=data&group_id=${group_id}`)
        ws_streams.push(ws)
        streams_data[stream_id] = [];
        setup_stream_websocket_listners(ws, stream_id)
    }
}

function setup_control_listners(ws){
    ws.onopen = () => {
        console.log(`control Websocket connected.....1`)
    }
    ws.onclose = ()=>{
        console.log(`......control websocket disconnected`)
    }
    ws.onerror = (error) => {
        console.log(`control ws Error occured`, error)
    }
    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data)
        // console.log(`RECEIVED DATA`, data)
        if (data.online_users){
            handle_online_users(data.online_users)
        }
        if (data.type && data.type === 'request'){
            handle_confirm_or_deny(data.sender_id)
        }
        if (data.type && data.type === 'response'){
            handle_response_confirm_or_deny(data.sender_id)
        }
        if (data.type && data.type === 'transfer_start'){
            // console.log(`FILE RECEIVE STARTED for stream ${data.stream_id}`,typeof(data.stream_id), data.start_byte, data.end_byte, data.filename)
            if (data.stream_id === 1){
                transfer_start_time = performance.now();
                received_filename = data.filename
                incoming_filesize = data.total_size
                stream_completed = 0
                total_received_bytes = 0
                is_transfer_active = true;

                // progress bar?
                show_download_progress()
            }
            streams_data[data.stream_id] = []
        }
        if (data.type && data.type === 'transfer_end'){
            // console.log("FILE RECEIVE ENDED", data.total_bytes)
            stream_completed++;

           if (stream_completed === NUM_STREAMS) {
                // console.log("All streams complete. Attempting reassembly.");
                reassemble_and_download();
                is_transfer_active = false;
            } else {
                console.warn(`Reassembly skipped. Waiting for ${NUM_STREAMS - stream_completed} more streams.`);
            }
        }
        if (data.type && data.type === 'transfer_cancel'){
            // console.log('Transfer Canceled by sender')
            const statusEl = document.getElementById('download-status')
            statusEl.innerHTML = `<span class="font-bold text-md text-red-400">Download canceled by User-${data['sender_id']}</span>`

            is_transfer_active = false;
            reset_receive_state()
            setTimeout(() => {
                hide_card('confirm-or-deny')
            }, 10000)
        }
    }
}

function setup_stream_websocket_listners(ws, stream_id){
    ws.onopen = () => {
        console.log(`Websocket connected ${stream_id}.....1`)
    }
    ws.onclose = ()=>{
        console.log(`......websocket ${stream_id} disconnected`)
    }
    ws.onerror = (error) => {
        console.log(`ws${stream_id} Error occured`, error)
    }
    ws.onmessage = async (event) => {
        // console.log("waiting for message", event, typeof(event.data))
        if (is_transfer_active && event.data instanceof Blob || event.data instanceof ArrayBuffer) {
            let buffer;
            
            if (event.data instanceof Blob) {
                buffer = await event.data.arrayBuffer(); 
            } else {
                buffer = event.data;
            }
            // console.log(`Stream ${stream_id} received chunk of size: ${buffer.byteLength} bytes.`);
            streams_data[stream_id].push(new Uint8Array(buffer))

            // updating progress ui( this is an expensive operation which requires the browser repaint the screen)
            const chunk_size = buffer.byteLength;
            total_received_bytes += chunk_size

            // so using throttle
            const now = performance.now()
            if (now - last_ui_update_time > 100){
                const progress = Math.min(
                    (total_received_bytes / incoming_filesize) * 100,
                    100
                )
                const duration_seconds = (now - transfer_start_time) / 1000;
                const speed_mbps = (total_received_bytes / (1024 * 1024)) / duration_seconds;
                const remaining_bytes = incoming_filesize - total_received_bytes;
                const eta = speed_mbps > 0 ? (remaining_bytes / (1024 * 1024)) / speed_mbps : 0;
                const progressEl = document.getElementById('download-progress')
                const statusEl = document.getElementById('download-status')

                if (progressEl){
                    progressEl.value = progress
                    statusEl.innerText = `Downloading... ${progress.toFixed(1)}% (${speed_mbps.toFixed(2)} MB/s) - ${eta.toFixed(0)}s left`;                }
                    last_ui_update_time = now;
                }
            return; // Exit to prevent JSON parsing
        }
    }
}

function handle_online_users(users){
    if (users.length <= 1){
        document.getElementById('container').classList.add('hidden')
        document.getElementById('all-users').innerHTML = 'No users found'
        return;
    }
    // console.log('inside create ui')
    let ul_element = document.getElementById('all-users')
    if (ul_element && ul_element.innerHTML){
        ul_element.innerHTML = ''
    }
    
    users.forEach((user_id) => {
        if (user_id != myid){
            if (!document.getElementById(`user-${user_id}`)) {
                const li = document.createElement('li');
                li.innerHTML = `
                    <div class="flex items-center justify-between p-3 rounded-lg bg-base-200 hover:bg-base-300 transition cursor-pointer">
                        <span class="font-medium">user-${user_id}</span>
                        <span class="badge badge-success badge-sm">online</span>
                    </div>
                `;

                li.id = `user-${user_id}`;
                li.classList.add("select-none");
                ul_element.appendChild(li);

                li.addEventListener('click', () => handle_user_clicked(user_id))
            }
        }
    })
}

function show_card(id){
    const el = document.getElementById(id)
    el.classList.remove('hidden')
    el.classList.add('animate-fade-in', 'animate-duration-200')
}

function hide_card(id){
    const el = document.getElementById(id)
    el.classList.add('hidden')
}

function handle_user_clicked(user_id) {
    // console.log(user_id, "Clicked");
    receiver_id = user_id;

    hide_card('start-file-stream')
    show_card('container')

    // document.getElementById('container-title').innerHTML = `user-${user_id}`;
    const title = document.getElementById('container-title');
    title.innerHTML = `user-${user_id}`;
    title.classList.add(
        'text-primary',
        'tracking-wide'
    )
}

function handle_confirm_or_deny(sender_id){
    document.getElementById('sender-id-show').innerHTML = sender_id
    // document.getElementById('container').classList.add('hidden')
    show_card('confirm-or-deny')
}

function handle_response_confirm_or_deny(){
    // this will prompt to select a simple file or a zip file
    const file_input_div = document.getElementById('start-file-stream')
    file_input_div.classList.remove('hidden')
    file_input_div.classList.add(
        'bg-base-200',
        'p-3',
        'rounded-lg'
    )
    hide_card('send-file-button')
}

function reassemble_and_download(){
    if (stream_completed < NUM_STREAMS){
        console.warn("Reassembly called without all completed")
        return
    }
    let final_chunks = []
    for (let i=1; i<=NUM_STREAMS; i++){
        final_chunks.push(...streams_data[i])
    }
    const totalCollectedSize = final_chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (totalCollectedSize !== incoming_filesize) {
        // progress ui related to show download error
        const statusEl = document.getElementById('download-status')
        if (statusEl){
            statusEl.classList.add('text-error')
            statusEl.innerText = 'File is corrupted download failed'
        }

        setTimeout(() => {
            hide_card('confirm-or-deny')
        }, 5000)

        console.error(`ERROR: Collected size (${totalCollectedSize}) does not match expected size (${incoming_filesize}). File is corrupted.`);
        // Don't download
        return;
    }
    // speed
    // const time_taken_ms = performance.now() - transfer_start_time;
    // const file_size_bytes = incoming_filesize;
    // Calculate speed:
    // const speed_MB_per_sec = (file_size_bytes / 1024 / 1024) / (time_taken_ms / 1000);
    // console.log(`Transfer Time: ${(time_taken_ms / 1000).toFixed(2)} seconds`);
    // console.log(`Download Speed: ${speed_MB_per_sec.toFixed(2)} MB/s`);
    // speed

    const fileBlob = new Blob(final_chunks)
    const url = URL.createObjectURL(fileBlob)
    const a = document.createElement('a')
    a.href = url;
    a.download = received_filename;
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a);
    // console.log('File downloaded Successfully')

    // progress ui related to show download finished
    const statusEl = document.getElementById('download-status')
    if (statusEl){
        statusEl.innerText = 'Download complete ✔'
    }

    setTimeout(() => {
        hide_card('confirm-or-deny')
    }, 5000)
}

async function streaming_file_multi_ws_server(){
    is_transfer_active = true;
    const fileInput = document.getElementById('file-choosen')
    const file = fileInput.files[0]

    if (!file){
        fileInput.classList.add('border-2', 'border-error', 'animate-shake')

        setTimeout(() => {
            fileInput.classList.remove('border-2', 'border-error', 'animate-shake')
        }, 2000)

        return
    }
    // show transfer cancel button and hide div close button
    // show_card('transfer-cancel-button')
    // hide_card('hide-container-button')

    // adding visual indicator
    const btn = document.getElementById('start-stream-button')
    btn.disabled = true
    btn.classList.remove('btn-primary')
    btn.classList.add('btn-ghost')
    btn.innerHTML = `
         <div class="flex flex-col items-center leading-tight">
            <span class="loading loading-spinner loading-xs mb-1"></span>
            <span class="text-[11px] text-gray-200 font-bold truncate max-w-35">
                Sending ${file.name}
            </span>
        </div>
        `
    //

    const file_size = file.size
    const segment_size = Math.ceil(file_size/NUM_STREAMS)
    const CHUNK_SIZE = 64 * 1024; // 64kb
    const MAXIMUM_BUFFER_SIZE = 4*1024*1024; // 4mb

    for (let i=0; i<NUM_STREAMS; i++){
        const ws = ws_streams[i];
        const stream_id = i+1

        const start_byte = segment_size * i;
        const end_byte = Math.min(segment_size * stream_id, file_size)

        // file send starting
        ws_control.send(JSON.stringify({
            'type': "transfer_start",
            'receiver_id': receiver_id,
            'stream_id': stream_id,
            'start_byte': start_byte,
            'end_byte': end_byte,
            'filename': file.name,
            'total_size': file.size
        }))

        // file send starting
        let offset = start_byte
        while(offset < end_byte){
            if (!is_transfer_active){
                // console.log("Transport aborted....")
                return;
            }
            if (ws.bufferedAmount > MAXIMUM_BUFFER_SIZE){
                // console.log(`Stream ${i+1}: Buffer full (${ws.bufferedAmount} bytes). Pausing send.`);
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }
            const chunk = file.slice(offset, Math.min(offset+CHUNK_SIZE, end_byte))
            const buffer = await chunk.arrayBuffer()
            ws.send(buffer)
            offset += CHUNK_SIZE
        }

        while (ws.bufferedAmount > 0) {
            // console.log(`Waiting for Stream ${i+1} buffer to clear: ${ws.bufferedAmount} bytes left.`);
            await new Promise(resolve => setTimeout(resolve, 50)); 
        }

        // end of file transfer
        ws_control.send(JSON.stringify({
            'type': "transfer_end",
            'stream_id': stream_id,
            'receiver_id': receiver_id,
            'total_received': file.size
        }))

        await new Promise(resolve => setTimeout(resolve, 50));
    }
    // console.log('Finished sending')
    // removing visual indicator
    btn.innerHTML = `
        <div class="flex items-center justify-center gap-2 text-success">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none"
                viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3"
                    d="M5 13l4 4L19 7" />
            </svg>
            <span class="text-xs font-semibold">Sent successfully</span>
        </div>
    `

    // keep disabled briefly so user notices success
    setTimeout(() => {
        btn.disabled = false
        btn.classList.add('btn-primary')
        btn.classList.remove('btn-ghost')
        btn.innerHTML = 'Send File'
    }, 1200)
    //

    // hide transfer cancel button and show div close button
    // hide_card('transfer-cancel-button')
    // show_card('hide-container-button')
}

function show_download_progress(){
    let container = document.getElementById('confirm-or-deny')

    container.innerHTML = `
        <div class="card-body gap-4">
            <span class="card-title text-base-content text-lg">
                Downloading file
            </span>

            <progress
                id="download-progress"
                class="progress progress-primary w-full"
                value="0"
                max="100"
            ></progress>

            <p
                id="download-status"
                class="text-sm text-base-content/70"
            >
                Preparing download...
            </p>
        </div>
    `

    show_card('confirm-or-deny')
}

function reset_receive_state(){
    for (let key in streams_data){
        streams_data[key] = [];
    }

    stream_completed = 0;
    total_received_bytes = 0;
    is_transfer_active = false;
}
init();