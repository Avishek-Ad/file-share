from django.urls import path
from transfer import views

urlpatterns = [
    path('', views.home, name='home_page'),
    path('discover/', views.discover, name='discover_page')
]