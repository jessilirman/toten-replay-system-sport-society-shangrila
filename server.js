const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

// --- CONFIGURAÇÕES ---
const PORTA = 3010;
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

// --- 1. LÓGICA DE GRAVAÇÃO (SEGMENTOS CURTOS PARA MAIOR PRECISÃO) ---
function iniciarGravacao(canal) {
    const pastaCam = path.join(GRAVACAO_DIR, `cam${canal}`);
    if (!fs.existsSync(pastaCam)) fs.mkdirSync(pastaCam);

    const rtspUrl = `rtsp://${DVR.user}:${DVR.pass}@${DVR.ip}:${DVR.porta}/cam/realmonitor?channel=${canal}&subtype=${DVR.subtype}`;

    console.log(`🎥 [CAM ${canal}] Gravando: Blocos de 15s (Alta precisão)...`);

    const ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', '15',      // Reduzido para 15s para capturar o clique mais rápido
        '-segment_wrap', '12',      // Mantém os últimos 180 segundos no buffer
        '-reset_timestamps', '1',
        '-y', path.join(pastaCam, 'chunk_%03d.ts')
    ]);

    ffmpeg.stderr.on('data', () => {}); // Silencia logs de debug do ffmpeg
    ffmpeg.on('close', (code) => {
        console.log(`⚠️ [CAM ${canal}] Conexão perdida (Code ${code}). Reiniciando em 2s...`);
        setTimeout(() => iniciarGravacao(canal), 2000);
    });
}

// --- 2. LÓGICA DE REPLAY (CORRIGIDA PARA SINCRONIA) ---
async function processarEvento(camId) {
    const timestamp = Date.now();
    const nomeArquivo = `replay_cam${camId}_${timestamp}.mp4`;
    const pastaCam = path.join(GRAVACAO_DIR, `cam${camId}`);
    const arquivoFinal = path.join(OUTPUT_DIR, nomeArquivo);
    const listaTxt = path.join(pastaCam, `list_${timestamp}.txt`);

    console.log(`🎬 [CAM ${camId}] Botão acionado! Aguardando 4s para fechar o bloco atual...`);

    try {
        // ESSENCIAL: Aguarda o bloco atual ser escrito no disco para não perder o final do vídeo
        await new Promise(resolve => setTimeout(resolve, 4000));

        const arquivos = fs.readdirSync(pastaCam).filter(f => f.endsWith('.ts'));

        if (arquivos.length < 3) {
            console.error(`❌ [CAM ${camId}] Buffer insuficiente (${arquivos.length} blocos).`);
            return;
        }

        // Pega os 4 blocos mais recentes (Aprox. 60 segundos de vídeo)
        const chunksParaUso = arquivos
            .map(f => ({
                nome: f,
                caminho: path.join(pastaCam, f),
                mtime: fs.statSync(path.join(pastaCam, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 4)
            .reverse();

        console.log(`⏳ [CAM ${camId}] Unindo blocos para replay sincronizado...`);

        const conteudoLista = chunksParaUso.map(c => `file '${c.caminho}'`).join('\n');
        fs.writeFileSync(listaTxt, conteudoLista);

        await new Promise((resolve, reject) => {
            const cut = spawn('ffmpeg', [
                '-f', 'concat', '-safe', '0', '-i', listaTxt,
                '-c', 'copy',
                '-y', arquivoFinal
            ]);

            cut.on('close', code => code === 0 ? resolve() : reject(new Error(`Erro no concat`)));
        });

        console.log(`✅ [CAM ${camId}] Replay gerado com sucesso!`);
        if (fs.existsSync(listaTxt)) fs.unlinkSync(listaTxt);

        processarFila();

    } catch (error) {
        console.error(`❌ [CAM ${camId}] Erro no processamento: ${error.message}`);
        if (fs.existsSync(listaTxt)) fs.unlinkSync(listaTxt);
    }
}

// --- 3. SISTEMA DE FILA E UPLOAD (SEM ALTERAÇÕES) ---
let enviando = false;
async function processarFila() {
    if (enviando) return;

    try {
        const arquivos = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4'));
        if (arquivos.length === 0) return;

        enviando = true;
        for (const arquivo of arquivos) {
            const caminhoArquivo = path.join(OUTPUT_DIR, arquivo);
            const match = arquivo.match(/cam(\d+)_/);
            const camId = match ? match[1] : '0';

            const form = new FormData();
            form.append('video', fs.createReadStream(caminhoArquivo));
            form.append('camId', camId);
            form.append('secret', API_KEY_VPS);

            await axios.post(VPS_URL, form, {
                headers: { ...form.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(`🚀 [UPLOAD] ${arquivo} enviado com sucesso!`);
            if (fs.existsSync(caminhoArquivo)) fs.unlinkSync(caminhoArquivo);
        }
    } catch (error) {
        console.error(`❌ [UPLOAD] Falha: ${error.message}`);
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
    const { cam } = req.body;
    if (!cam) return res.status(400).json({ error: 'Falta parâmetro cam' });

    const agora = Date.now();
    if (ultimoClique[cam] && (agora - ultimoClique[cam] < 15000)) {
        return res.status(429).json({ error: 'Spam bloqueado' });
    }

    ultimoClique[cam] = agora;
    res.json({ status: 'Solicitação recebida, processando replay...' });

    processarEvento(cam);
});

app.listen(PORTA, () => {
    console.log(`🔥 TOTEM ATIVO NA PORTA ${PORTA}`);
    CANAIS.forEach(iniciarGravacao);
});
