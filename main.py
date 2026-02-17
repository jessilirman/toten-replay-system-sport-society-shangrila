import evdev
import requests
import threading
import time
import os
import datetime
import sys

# --- CONFIGURAÇÃO ---
# Aponta para o Node.js que roda no mesmo notebook
URL_API_LOCAL = 'http://localhost:3000/api/record'
LOG_FILE = '/opt/replay-system/registro_botoes.log'

# Mapeamento Serial -> Câmera
MAPA_SERIAIS = {
    'BE104C63': 9,   # Câmera Fundo
    'BE10448F': 13   # Câmera Bar
}

def log(msg):
    ts = datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    texto = f"[{ts}] {msg}"
    print(texto)
    sys.stdout.flush()
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(texto + "\n")
    except:
        pass

def acionar_camera(cam):
    log(f"🔘 BOTÃO APERTADO! Câmera {cam}")
    try:
        # Envia o JSON exigido pelo Node
        r = requests.post(URL_API_LOCAL, json={'cam': str(cam)}, timeout=3)
        if r.status_code == 200:
            log(f"   ✅ Sucesso: Node.js iniciou corte.")
        elif r.status_code == 429:
            log(f"   🛡️ Ignorado: Spam protection ativo.")
        else:
            log(f"   ⚠️ Erro Node: {r.status_code}")
    except Exception as e:
        log(f"   ❌ Erro Conexão Local: {e}")

def monitorar_device(path, cam):
    log(f"🔌 Monitorando Hardware: {path} (CAM {cam})")
    try:
        device = evdev.InputDevice(path)
        for event in device.read_loop():
            # Detecta o clique da tecla
            if event.type == evdev.ecodes.EV_KEY and event.value == 1:
                threading.Thread(target=acionar_camera, args=(cam,)).start()
    except Exception as e:
        log(f"💀 Dispositivo {cam} desconectado: {e}")

def main():
    log("🚀 INICIANDO MONITOR DE BOTÕES")
    threads = {}

    while True:
        if os.path.exists('/dev/input/by-id/'):
            arquivos = os.listdir('/dev/input/by-id/')
            for arquivo in arquivos:
                full_path = os.path.join('/dev/input/by-id/', arquivo)
                for serial, cam in MAPA_SERIAIS.items():
                    if serial in arquivo and 'event-kbd' in arquivo:
                        if cam not in threads or not threads[cam].is_alive():
                            t = threading.Thread(target=monitorar_device, args=(full_path, cam), daemon=True)
                            t.start()
                            threads[cam] = t
        
        # Intervalo de 5s evita uso excessivo de CPU
        time.sleep(5)

if __name__ == "__main__":
    main()
