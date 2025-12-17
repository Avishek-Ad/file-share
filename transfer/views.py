from django.shortcuts import render

def home(request):
    return render(request, 'transfer/home.html')

def discover(request):
    return render(request, 'transfer/discover.html')