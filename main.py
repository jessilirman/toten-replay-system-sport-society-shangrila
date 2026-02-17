const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

// --- CONFIGURAÇÕES ---
const PORTA = 3000;
const VPS_URL = 'http://93.127.212.187:3000/api/upload-video'; 
const API_KEY_VPS = 'maciel_secure_upload_key_2024';

const GRAVACAO_DIR = path.join(__dirname, 'buffer_cameras');
const OUTPUT_DIR = path.join(__dirname, 'saida_videos');

// Configuração do DVR
const DVR = {
    ip: '10.1.1.41', porta: '554', user: 'admin', pass: 'ptlm4030jx', subtype: '0'
};
const CANAIS = [9, 13];

// --- INICIALIZAÇÃO ---
if (!fs.existsSync(GRAVACAO_DIR)) fs.mkdirSync(GRAVACAO_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- 1. LÓGICA DE GRAVAÇÃO (BUFFER OTIMIZADO) ---
function iniciarGravacao(canal) {
    const pastaCam = path.join(GRAVACAO_DIR, `cam${canal}`);
    if (!fs.existsSync(pastaCam)) fs.mkdirSync(pastaCam);

    const rtspUrl = `rtsp://${DVR.user}:${DVR.pass}@${DVR.ip}:${DVR.porta}/cam/realmonitor?channel=${canal}&subtype=${DVR.subtype}`;

    console.log(`🎥 [CAM ${canal}] Gravando: Blocos de 45s (Mantendo últimos 4)...`);
    const ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', '45',
        '-segment_wrap', '4',
        '-reset_timestamps', '1',
        '-y', path.join(pastaCam, 'chunk_%03d.ts')
    ]);

    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('close', (code) => {
        console.log(`⚠️ [CAM ${canal}] Caiu (Código ${code}). Reiniciando em 2s...`);
        setTimeout(() => iniciarGravacao(canal), 2000);
    });
}

// --- 2. LÓGICA DE CORTE (REPLAY) ---
async function processarEvento(camId) {
    const timestamp = Date.now();
    const nomeArquivo = `replay_cam${camId}_${timestamp}.mp4`;
    const pastaCam = path.join(GRAVACAO_DIR, `cam${camId}`);
    const arquivoFinal = path.join(OUTPUT_DIR, nomeArquivo);
    const listaTxt = path.join(pastaCam, `list_${timestamp}.txt`);

    console.log(`🎬 [CAM ${camId}] Botão acionado! Gerando replay...`);

    try {
        const arquivos = fs.readdirSync(pastaCam)
            .filter(f => f.endsWith('.ts'))
            .map(f => ({ nome: f, caminho: path.join(pastaCam, f), mtime: fs.statSync(path.join(pastaCam, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        const chunksParaUso = arquivos.slice(0, 3).reverse();
        if (chunksParaUso.length === 0) throw new Error("Sem gravações disponíveis ainda.");

        const conteudoLista = chunksParaUso.map(c => `file '${c.caminho}'`).join('\n');
        fs.writeFileSync(listaTxt, conteudoLista);

        await new Promise((resolve, reject) => {
            const cut = spawn('ffmpeg', [
                '-f', 'concat', '-safe', '0', '-i', listaTxt,
                '-sseof', '-30',
                '-t', '30',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-y', arquivoFinal
            ]);
            cut.on('close', code => code === 0 ? resolve() : reject('Erro no corte FFmpeg'));
        });

        console.log(`✅ [CAM ${camId}] Vídeo criado e adicionado à fila: ${nomeArquivo}`);
        fs.unlinkSync(listaTxt); 
        
        // AQUI MUDOU: Não envia para a VPS imediatamente. Apenas salva na pasta.
        // O sistema de Fila (abaixo) cuidará do envio.

    } catch (error) {
        console.error(`❌ [CAM ${camId}] Erro: ${error.message}`);
    }
}

// --- 3. SISTEMA DE FILA E UPLOAD (PROTEÇÃO CONTRA QUEDA DE INTERNET) ---
let enviando = false;

async function processarFila() {
    if (enviando) return; // Evita enviar duas coisas ao mesmo tempo
    
    try {
        const arquivos = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4'));
        if (arquivos.length === 0) return; // Fila vazia

        enviando = true;
        console.log(`🔄 Fila de Upload: ${arquivos.length} vídeo(s) aguardando...`);

        for (const arquivo of arquivos) {
            const caminhoArquivo = path.join(OUTPUT_DIR, arquivo);
            
            // Extrai qual câmera gravou isso com base no nome do arquivo (ex: replay_cam9_123.mp4 -> 9)
            const match = arquivo.match(/cam(\d+)_/);
            const camId = match ? match[1] : '0';

            console.log(`☁️ Tentando enviar ${arquivo}...`);
            
            const form = new FormData();
            form.append('video', fs.createReadStream(caminhoArquivo));
            form.append('camId', camId);
            form.append('secret', API_KEY_VPS);

            // Tenta enviar. Se a internet estiver caída, vai dar erro e cair no catch
            const response = await axios.post(VPS_URL, form, {
                headers: { ...form.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(`🚀 Upload Sucesso! VPS respondeu: ${response.data.message}`);
            
            // APAGA do Totem SÓ DEPOIS QUE A VPS CONFIRMAR QUE RECEBEU!
            if (fs.existsSync(caminhoArquivo)) fs.unlinkSync(caminhoArquivo);
        }
    } catch (error) {
        console.error(`❌ Falha no Upload (Sem internet?): ${error.message}`);
        console.log("⏳ O vídeo continuará na fila e o sistema tentará novamente em 30 segundos.");
    } finally {
        enviando = false;
    }
}

// Inicia o verificador da fila a cada 30 segundos
setInterval(processarFila, 30000);


// --- 4. API LOCAL ---
const app = express();
app.use(cors());
app.use(express.json()); 

const ultimoClique = {};

app.post('/api/record', (req, res) => {
    if (!req.body || !req.body.cam) {
        return res.status(400).json({ error: 'Parâmetro "cam" obrigatório' });
    }

    const { cam } = req.body;
    const agora = Date.now();

    if (ultimoClique[cam] && (agora - ultimoClique[cam] < 15000)) {
        console.log(`🛡️ [CAM ${cam}] Spam bloqueado.`);
        return res.status(429).json({ error: 'Aguarde...' });
    }

    ultimoClique[cam] = agora;
    processarEvento(cam);
    res.json({ status: 'Processando localmente e adicionado à fila...' });
});

app.listen(PORTA, () => {
    console.log(`🔥 SERVER TOTEM (Node) | Porta ${PORTA}`);
    console.log(`📹 Config: Segmentos de 45s | Proteção de Internet ATIVADA`);
    CANAIS.forEach(iniciarGravacao);
    processarFila(); // Checa se já tem vídeos parados logo ao ligar
});
