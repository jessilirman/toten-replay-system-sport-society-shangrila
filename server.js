const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

// --- CONFIGURAÇÕES ---
const PORTA = 3000;
const VPS_URL = 'https://vcnatela.canchamaciel.com.br/api/upload-video';
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

// --- 2. LÓGICA DE CORTE (REPLAY) - CORRIGIDA E BLINDADA ---
async function processarEvento(camId) {
    const timestamp = Date.now();
    const nomeArquivo = `replay_cam${camId}_${timestamp}.mp4`;
    const pastaCam = path.join(GRAVACAO_DIR, `cam${camId}`);
    const arquivoFinal = path.join(OUTPUT_DIR, nomeArquivo);
    const listaTxt = path.join(pastaCam, `list_${timestamp}.txt`);

    console.log(`🎬 [CAM ${camId}] Botão acionado! Gerando replay...`);

    try {
        const arquivos = fs.readdirSync(pastaCam).filter(f => f.endsWith('.ts'));

        // Trava de segurança: precisa de pelo menos 2 arquivos
        if (arquivos.length < 2) {
            console.error(`❌ [CAM ${camId}] Apenas ${arquivos.length} blocos gravados. Preciso de pelo menos 2. Aguarde!`);
            return; 
        }

        // Pega os 2 arquivos mais recentes (Garante os últimos ~90 segundos)
        const chunksParaUso = arquivos
            .map(f => ({ nome: f, caminho: path.join(pastaCam, f), mtime: fs.statSync(path.join(pastaCam, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 2)
            .reverse();

        console.log(`⏳ [CAM ${camId}] Unindo ${chunksParaUso.length} pedaços...`);

        const conteudoLista = chunksParaUso.map(c => `file '${c.caminho}'`).join('\n');
        fs.writeFileSync(listaTxt, conteudoLista);

        await new Promise((resolve, reject) => {
            // Comando FFmpeg limpo: apenas une os blocos sem tentar "fatiar" o tempo
            const cut = spawn('ffmpeg', [
                '-f', 'concat', '-safe', '0', '-i', listaTxt,
                '-c', 'copy', 
                '-y', arquivoFinal
            ]);

            cut.on('close', code => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg falhou com código ${code}`));
                }
            });

            cut.on('error', (err) => {
                 reject(new Error(`Erro ao iniciar processo do FFmpeg: ${err.message}`));
            });
        });

        console.log(`✅ [CAM ${camId}] Vídeo criado e adicionado à fila: ${nomeArquivo}`);
        
        // Limpa a lista de texto após o uso
        if (fs.existsSync(listaTxt)) fs.unlinkSync(listaTxt);

    } catch (error) {
        console.error(`❌ [CAM ${camId}] Erro no Corte: ${error.message}`);
        if (fs.existsSync(listaTxt)) fs.unlinkSync(listaTxt);
    }
}

// --- 3. SISTEMA DE FILA E UPLOAD ---
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
            const match = arquivo.match(/cam(\d+)_/);
            const camId = match ? match[1] : '0';

            console.log(`☁️ Tentando enviar ${arquivo}...`);

            const form = new FormData();
            form.append('video', fs.createReadStream(caminhoArquivo));
            form.append('camId', camId);
            form.append('secret', API_KEY_VPS);

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
    
    // Responde rapidinho pro Python não travar, e manda processar em background
    res.json({ status: 'Processando localmente e adicionado à fila...' });
    
    // Inicia o corte de fato
    processarEvento(cam);
});

app.listen(PORTA, () => {
    console.log(`🔥 SERVER TOTEM (Node) | Porta ${PORTA}`);
    console.log(`📹 Config: Segmentos de 45s | Proteção de Internet ATIVADA`);
    CANAIS.forEach(iniciarGravacao);
    processarFila(); 
});
