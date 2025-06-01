const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const app = express();

// Lista de videos de YouTube
const videoUrls = [
    'https://youtu.be/BR3NFEXuSv0?si=mSCaAzM4r6NjbC5L',
    'https://youtu.be/XOt3Rgs-tt0?si=RU86-8VqLKJ3TH60',
    'https://youtu.be/nD2TZahdAJY?si=3DfZBqXeEhAsgQH8',
    'https://youtu.be/lKgDhWCEfQo?si=6mD0EbDePrs_EAiI',
    'https://youtu.be/4uwZ-80XAqw?si=b62G5uNlWCdHBcnT',
    'https://youtu.be/NRQ7Kv7-8Hs?si=kFxtzMTvOwVFRx84',
    'https://youtu.be/rzDrGSWteZg?si=CqsE3ffZU5H0Mnyg'
];

const SRT_ENDPOINT = 'srt://rtmp.livepeer.com:2935?streamid=95e4-urol-igfh-cehi';
const DOWNLOAD_DIR = './downloads';

// Crear directorio de descargas si no existe
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR);
}

// Función para extraer video ID de URL de YouTube
function extractVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([^&\n?#]+)/);
    return match ? match[1] : null;
}

// Función para descargar video usando la API de Vreden
async function downloadVideo(youtubeUrl) {
    try {
        console.log(`Descargando: ${youtubeUrl}`);
        
        const apiUrl = `https://api.vreden.my.id/api/ytmp4?url=${encodeURIComponent(youtubeUrl)}`;
        const response = await axios.get(apiUrl);
        
        if (response.data.status === 200 && response.data.result.download.status) {
            const videoData = response.data.result;
            const downloadUrl = videoData.download.url;
            const filename = `${videoData.metadata.videoId}.mp4`;
            const filepath = path.join(DOWNLOAD_DIR, filename);
            
            // Descargar el archivo de video
            const videoResponse = await axios({
                method: 'GET',
                url: downloadUrl,
                responseType: 'stream'
            });
            
            const writer = fs.createWriteStream(filepath);
            videoResponse.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    console.log(`Video descargado: ${filename}`);
                    resolve({
                        filepath,
                        metadata: videoData.metadata
                    });
                });
                writer.on('error', reject);
            });
        } else {
            throw new Error('Error en la API de Vreden');
        }
    } catch (error) {
        console.error(`Error descargando ${youtubeUrl}:`, error.message);
        return null;
    }
}

// Función para transmitir video usando node-ffmpeg (alternativa a FFmpeg binario)
async function streamVideo(videoPath) {
    return new Promise((resolve, reject) => {
        console.log(`Transmitiendo: ${videoPath}`);
        
        // Usar ffmpeg a través de node (requiere tener ffmpeg instalado)
        // Para Render, puedes usar alternativas como GStreamer o crear un contenedor personalizado
        const ffmpeg = spawn('ffmpeg', [
            '-re',                          // Leer entrada a velocidad nativa
            '-i', videoPath,               // Archivo de entrada
            '-c:v', 'libx264',             // Codec de video
            '-preset', 'ultrafast',        // Preset rápido
            '-tune', 'zerolatency',        // Optimizar para latencia baja
            '-c:a', 'aac',                 // Codec de audio
            '-b:v', '2500k',               // Bitrate de video
            '-b:a', '128k',                // Bitrate de audio
            '-f', 'mpegts',                // Formato de salida
            SRT_ENDPOINT                   // Destino SRT
        ]);
        
        ffmpeg.stdout.on('data', (data) => {
            console.log(`FFmpeg stdout: ${data}`);
        });
        
        ffmpeg.stderr.on('data', (data) => {
            console.log(`FFmpeg stderr: ${data}`);
        });
        
        ffmpeg.on('close', (code) => {
            console.log(`FFmpeg terminó con código: ${code}`);
            resolve(code);
        });
        
        ffmpeg.on('error', (error) => {
            console.error('Error en FFmpeg:', error);
            reject(error);
        });
    });
}

// Función alternativa usando GStreamer (más compatible con Render)
async function streamVideoGStreamer(videoPath) {
    return new Promise((resolve, reject) => {
        console.log(`Transmitiendo con GStreamer: ${videoPath}`);
        
        const gst = spawn('gst-launch-1.0', [
            'filesrc', `location=${videoPath}`,
            '!', 'decodebin',
            '!', 'videoconvert',
            '!', 'x264enc', 'tune=zerolatency', 'bitrate=2500',
            '!', 'h264parse',
            '!', 'mpegtsmux',
            '!', 'srtserversink', `uri=${SRT_ENDPOINT}`
        ]);
        
        gst.stdout.on('data', (data) => {
            console.log(`GStreamer: ${data}`);
        });
        
        gst.stderr.on('data', (data) => {
            console.log(`GStreamer stderr: ${data}`);
        });
        
        gst.on('close', (code) => {
            console.log(`GStreamer terminó con código: ${code}`);
            resolve(code);
        });
        
        gst.on('error', (error) => {
            console.error('Error en GStreamer:', error);
            reject(error);
        });
    });
}

// Función principal para transmitir playlist
async function startStreaming() {
    console.log('Iniciando transmisión de playlist...');
    
    let currentIndex = 0;
    
    while (true) {
        const currentUrl = videoUrls[currentIndex];
        console.log(`\n--- Procesando video ${currentIndex + 1}/${videoUrls.length} ---`);
        
        // Descargar video
        const videoInfo = await downloadVideo(currentUrl);
        
        if (videoInfo) {
            try {
                // Intentar transmitir con FFmpeg primero
                await streamVideo(videoInfo.filepath);
            } catch (error) {
                console.log('FFmpeg falló, intentando con GStreamer...');
                try {
                    await streamVideoGStreamer(videoInfo.filepath);
                } catch (gstError) {
                    console.error('Error en ambos métodos de streaming:', gstError);
                }
            }
            
            // Limpiar archivo después de transmitir
            try {
                fs.unlinkSync(videoInfo.filepath);
                console.log(`Archivo eliminado: ${videoInfo.filepath}`);
            } catch (err) {
                console.error('Error eliminando archivo:', err);
            }
        }
        
        // Pasar al siguiente video (loop infinito)
        currentIndex = (currentIndex + 1) % videoUrls.length;
        
        // Pequeña pausa entre videos
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// Rutas de la API
app.get('/', (req, res) => {
    res.json({
        status: 'YouTube to SRT Streaming Server',
        endpoint: SRT_ENDPOINT,
        videos: videoUrls.length,
        message: 'Servidor funcionando correctamente'
    });
});

app.get('/start', async (req, res) => {
    res.json({ message: 'Iniciando transmisión...' });
    startStreaming().catch(console.error);
});

app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        downloadDir: DOWNLOAD_DIR,
        endpoint: SRT_ENDPOINT,
        videos: videoUrls
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Endpoint SRT: ${SRT_ENDPOINT}`);
    console.log(`Videos en playlist: ${videoUrls.length}`);
    
    // Iniciar transmisión automáticamente
    console.log('\nIniciando transmisión automática en 5 segundos...');
    setTimeout(() => {
        startStreaming().catch(console.error);
    }, 5000);
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promesa rechazada no manejada:', reason);
});
