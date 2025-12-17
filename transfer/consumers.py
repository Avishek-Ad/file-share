from channels.generic.websocket import AsyncWebsocketConsumer
from urllib.parse import parse_qs
import json

ONLINE_USERS = {}
SENDER_RECEIVER_MAP = {}

class TransferConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        qs = parse_qs(self.scope["query_string"].decode())
        self.user_id = qs.get("myid", [None])[0]
        self.purpose = qs.get("purpose", [None])[0]
        self.stream_id = qs.get("stream_id", [None])[0]
        self.group_id = qs.get('group_id', [None])[0]
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
                f"user-data-{self.user_id}-stream-{self.stream_id}", self.channel_name
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
                f"user-data-{self.user_id}-stream-{self.stream_id}", self.channel_name
            )

    
    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            if self.purpose != 'data':
                # print("Error: binary received from CONTROL channel")
                return

            current_receiver_id = SENDER_RECEIVER_MAP.get(self.user_id)            
            if current_receiver_id:
                await self.channel_layer.group_send(
                    f"user-data-{current_receiver_id}-stream-{self.stream_id}",
                    {
                        'type': "file.transfer.data.bin",
                        'chunk_data': bytes_data,
                    }
                )
            
        elif text_data:
            data = json.loads(text_data)
            if data['type'] == 'request':
                await self.channel_layer.group_send(
                    f"user-control-{data['receiver_id']}",
                    {
                        'type': 'confirm.or.deny.receive',
                        'sender_id': data['sender_id'],
                        'message_type': data['type'],

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
            elif data['type'] == 'transfer_start':
                SENDER_RECEIVER_MAP[self.user_id] = data['receiver_id']
                await self.channel_layer.group_send(
                f"user-control-{data['receiver_id']}",
                {
                    'type': "file.transfer_start",
                    'filename': data['filename'],
                    'total_size': data['total_size'],
                    'stream_id': data['stream_id'],
                    'start_byte': data['start_byte'],
                    'end_byte': data['end_byte']
                }
            )
            elif data['type'] == 'transfer_end':
                if self.user_id in SENDER_RECEIVER_MAP:
                    del SENDER_RECEIVER_MAP[self.user_id]
                await self.channel_layer.group_send(
                f"user-control-{data['receiver_id']}",
                {
                    'type': "file.transfer.end.bin",
                    'total_bytes': data['total_received'],
                    'stream_id': data['stream_id']
                }
            )
            elif data['type'] == 'transfer_cancel':
                # print("CANCELED..................")
                if data['sender_id'] in SENDER_RECEIVER_MAP:
                    del SENDER_RECEIVER_MAP[data['sender_id']]
                await self.channel_layer.group_send(
                    f"user-control-{data['receiver_id']}",
                    {
                        'type': "file.transfer.cancel",
                        'sender_id': data['sender_id'],
                    }
                )
            else:
                pass

    async def online_users(self, event):
        online_users = event['online_users']
        await self.send(text_data=json.dumps({'online_users':online_users}))

    async def confirm_or_deny_receive(self, event):
        sender_id = event['sender_id']
        message_type = event['message_type']
        await self.send(text_data=json.dumps({'type':message_type, 'sender_id':sender_id}))

    async def confirm_or_deny_response(self, event):
        receiver_id = event['receiver_id']
        message_type = event['message_type']
        await self.send(text_data=json.dumps({'type':message_type, 'receiver_id':receiver_id}))

    async def file_transfer_start(self, event):
        await self.send(text_data=json.dumps({
            'type': 'transfer_start',
            'filename': event['filename'],
            'total_size': event['total_size'],
            'stream_id': event['stream_id'],
            'start_byte': event['start_byte'],
            'end_byte': event['end_byte']
        }))

    async def file_transfer_error(self, event):
        await self.send(text_data=json.dumps({
            'type': 'transfer_error',
            'message': event['message']
        }))

    async def file_transfer_end_bin(self, event):
        await self.send(text_data=json.dumps({
            'type': "transfer_end",
            'total_bytes': event['total_bytes'],
            'stream_id': event['stream_id']
        }))

    async def file_transfer_cancel(self, event):
        await self.send(text_data=json.dumps({
            'type': 'transfer_cancel',
            'sender_id': event['sender_id']
        }))

    async def file_transfer_data_bin(self, event):
        await self.send(bytes_data=event['chunk_data'])