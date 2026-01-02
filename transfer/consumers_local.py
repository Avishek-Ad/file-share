from channels.generic.websocket import AsyncWebsocketConsumer
from urllib.parse import parse_qs
import json

ONLINE_USERS = {}
SENDER_RECEIVER_MAP = {}

class TransferConsumerLocal(AsyncWebsocketConsumer):
    async def connect(self):
        headers = dict(self.scope["headers"])

        x_forwarded_for = headers.get(b"x-forwarded-for")
        if x_forwarded_for:
            public_ip = x_forwarded_for.decode().split(",")[0].strip()
        else:
            public_ip = self.scope["client"][0]

        qs = parse_qs(self.scope["query_string"].decode())
        self.user_id = qs.get("myid", [None])[0]
        self.purpose = qs.get("purpose", [None])[0]
        self.group_id = f"only-public-{public_ip}"
        self.group_name = f"file-transfer-group-{self.group_id}"
        
        # only control channel will be here
        if self.purpose == 'control':
            if self.group_id not in ONLINE_USERS:
                ONLINE_USERS[self.group_id] = set()
            
            ONLINE_USERS[self.group_id].add(self.user_id)

            await self.channel_layer.group_add(
                self.group_name, self.channel_name
            )
            await self.channel_layer.group_add(
                f"user-control-{self.user_id}", self.channel_name
            )

        # all my data channel will be here
        if self.purpose == 'data':
            await self.channel_layer.group_add(
                f"user-data-{self.user_id}", self.channel_name
            )

        await self.accept()

        # send all the online user to all the members in the group
        if self.purpose == 'control':
            await self.channel_layer.group_send(
                self.group_name,
                {
                    'type': 'online.users',
                    'online_users': list(ONLINE_USERS[self.group_id])
                }
            )
    
    async def disconnect(self, close_code):
        if self.purpose == 'control':
            ONLINE_USERS[self.group_id].discard(self.user_id)
            
            await self.channel_layer.group_discard(
                self.group_name, self.channel_name
            )
            await self.channel_layer.group_discard(
                f"user-control-{self.user_id}", self.channel_name
            )
            await self.channel_layer.group_send(
                self.group_name,
                {
                    'type': 'online.users',
                    'online_users': list(ONLINE_USERS[self.group_id])
                }
            )

        if self.purpose == 'data':
            await self.channel_layer.group_discard(
                f"user-data-{self.user_id}", self.channel_name
            )

    
    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            if self.purpose != 'data':
                # print("Error: binary received from CONTROL channel")
                return

            current_receiver_id = SENDER_RECEIVER_MAP.get(self.user_id)            
            if current_receiver_id:
                await self.channel_layer.group_send(
                    f"user-data-{current_receiver_id}",
                    {
                        'type': "file.transfer.data.bin",
                        'chunk_data': bytes_data,
                    }
                )
            
        elif text_data:
            data = json.loads(text_data)
            if data['type'] == 'flow_control':
                await self.channel_layer.group_send(
                    f"user-control-{data['sender_id']}",
                    {
                        'type': 'send.flow.control',
                        'sender_id': data['sender_id'],
                        'download_bps': data['download_bps'],
                        'buffer_level': data['buffer_level']
                    }
                )
            elif data['type'] == 'request':
                if data['receiver_id'] in list(SENDER_RECEIVER_MAP.keys()) or data['receiver_id'] in list(SENDER_RECEIVER_MAP.values()):
                    print(f"{data['receiver_id']} says i am busy dont disturb me {data['sender_id']}")
                    await self.channel_layer.group_send(
                        f"user-control-{data['sender_id']}",
                        {
                            'type': 'i.am.busy',
                        }
                    )
                else:
                    await self.channel_layer.group_send(
                        f"user-control-{data['receiver_id']}",
                        {
                            'type': 'confirm.or.deny.receive',
                            'sender_id': data['sender_id'],
                            'message_type': data['type'],
                            'filename': data['filename'],
                            'filesize': data['filesize']
                        }
                    )
            elif data['type'] == 'response':
                await self.channel_layer.group_send(
                    f"user-control-{data['sender_id']}",
                    {
                        'type': 'confirm.or.deny.response',
                        'receiver_id': data['receiver_id'],
                        'message_type': data['type'],
                    }
                )
            elif data['type'] == 'response_cancel':
                await self.channel_layer.group_send(
                    f"user-control-{data['sender_id']}",
                    {
                        'type': 'confirm.or.deny.response.cancel',
                        'receiver_id': data['receiver_id'],
                    }
                )
            elif data['type'] == 'transfer_start':
                SENDER_RECEIVER_MAP[self.user_id] = data['receiver_id']
                await self.channel_layer.group_send(
                f"user-control-{data['receiver_id']}",
                {
                    'type': "file.transfer_start",
                }
            )
            elif data['type'] == 'transfer_end':
                # the receiver will send a transfer end after successful 
                del SENDER_RECEIVER_MAP[str(data['sender_id'])]
                
            elif data['type'] == 'transfer_cancel':
                # print("CANCELED..................")
                if data['sender_id'] in SENDER_RECEIVER_MAP:
                    del SENDER_RECEIVER_MAP[str(data['sender_id'])]
                await self.channel_layer.group_send(
                    f"user-control-{data['receiver_id']}",
                    {
                        'type': "file.transfer.cancel",
                        'sender_id': data['sender_id'],
                    }
                )
            else:
                pass
    
    async def i_am_busy(self, event):
        await self.send(text_data=json.dumps({'type':"i_am_busy"}))

    async def online_users(self, event):
        online_users = event['online_users']
        await self.send(text_data=json.dumps({'online_users':online_users}))

    async def send_flow_control(self, event):
        await self.send(text_data=json.dumps({
            'type': 'flow_control',
            'sender_id': event['sender_id'],
            'download_bps': event['download_bps'],
            'buffer_level': event['buffer_level']   
            }))

    async def confirm_or_deny_receive(self, event):
        sender_id = event['sender_id']
        message_type = event['message_type']
        await self.send(text_data=json.dumps({
            'type':message_type,
            'sender_id':sender_id,
            'filename': event['filename'],
            'filesize': event['filesize']   
            }))

    async def confirm_or_deny_response(self, event):
        receiver_id = event['receiver_id']
        message_type = event['message_type']
        await self.send(text_data=json.dumps({'type':message_type, 'receiver_id':receiver_id}))

    async def confirm_or_deny_response_cancel(self, event):
        receiver_id = event['receiver_id']
        await self.send(text_data=json.dumps({'type':'response_cancel', 'receiver_id':receiver_id}))


    async def file_transfer_start(self, event):
        await self.send(text_data=json.dumps({
            'type': 'transfer_start',
        }))

    async def file_transfer_error(self, event):
        await self.send(text_data=json.dumps({
            'type': 'transfer_error',
            'message': event['message']
        }))

    async def file_transfer_end_bin(self, event):
        await self.send(text_data=json.dumps({
            'type': "transfer_end",
            'total_received': event['total_received'],
        }))

    async def file_transfer_cancel(self, event):
        await self.send(text_data=json.dumps({
            'type': 'transfer_cancel',
            'sender_id': event['sender_id']
        }))

    async def file_transfer_data_bin(self, event):
        await self.send(bytes_data=event['chunk_data'])