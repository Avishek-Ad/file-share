from django.urls import re_path
from .consumers import TransferConsumer
from .consumers_local import TransferConsumerLocal

websocket_urlpatterns = [
     re_path(r'ws/transfer/?$', TransferConsumer.as_asgi()),
     re_path(r'ws/transfer/local/?$', TransferConsumerLocal.as_asgi()),
]