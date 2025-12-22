from django.shortcuts import render

def home(request):
    return render(request, 'transfer/home.html')

def discover(request):
    return render(request, 'transfer/discover.html')

def local_discovery(request):
    return render(request, 'transfer/discover_for_local.html')