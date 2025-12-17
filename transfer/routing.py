from django.urls import re_path
from .consumers import TransferConsumer

websocket_urlpatterns = [
     re_path(r'ws/transfer/?$', TransferConsumer.as_asgi()),
]