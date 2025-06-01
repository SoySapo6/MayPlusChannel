const express = require('express');
const ytdl = require('ytdl-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

// URL del stream SRT
const SRT_URL = 'srt://rtmp.livepeer.com:2935?streamid=95e4-urol-igfh-cehi';

let currentVideoIndex = 0;
let isStreaming = false;
let streamProcess = null;

// Función para extraer video ID de URL de YouTube
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// Función para obtener información del video
async function getVideoInfo(url) {
    try {
        const info = await ytdl.getInfo(url);
        return {
            title: info.videoDetails.title,
            duration: info.videoDetails.lengthSeconds,
            formats: info.formats
        };
    } catch (error) {
        console.error('Error obteniendo info del video:', error);
        return null;
    }
}

// Función principal de streaming
async function startStreaming() {
    if (isStreaming) {
        console.log('Ya hay un stream en progreso');
        return;
    }

    isStreaming = true;
    console.log('Iniciando streaming...');

    while (isStreaming) {
        const currentUrl = videoUrls[currentVideoIndex];
        console.log(`Streaming video ${currentVideoIndex + 1}/${videoUrls.length}: ${currentUrl}`);

        try {
            const videoInfo = await getVideoInfo(currentUrl);
            if (!videoInfo) {
                console.error('No se pudo obtener información del video, saltando...');
                nextVideo();
                continue;
            }

            console.log(`Título: ${videoInfo.title}`);
            console.log(`Duración: ${videoInfo.duration} segundos`);

            // Obtener el stream de video
            const videoStream = ytdl(currentUrl, {
                quality: 'highest',
                filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio
            });

            // Crear proceso de streaming usando node-srt (alternativa a ffmpeg)
            await streamVideo(videoStream, videoInfo.duration);

        } catch (error) {
            console.error('Error en el streaming:', error);
        }

        nextVideo();
        
        // Pequeña pausa entre videos
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// Función para hacer stream del video usando una alternativa a ffmpeg
function streamVideo(videoStream, duration) {
    return new Promise((resolve, reject) => {
        // Usar gstreamer como alternativa a ffmpeg (más común en sistemas cloud)
        const gstCommand = [
            'gst-launch-1.0',
            '-v',
            'fdsrc', 'fd=0',
            '!', 'decodebin',
            '!', 'videoconvert',
            '!', 'x264enc', 'tune=zerolatency', 'bitrate=2500',
            '!', 'mpegtsmux',
            '!', 'srtsink', `uri=${SRT_URL}`
        ];

        // Si gstreamer no está disponible, usar una implementación básica con Node.js
        if (!isGStreamerAvailable()) {
            console.log('GStreamer no disponible, usando implementación básica...');
            return streamWithNodeSRT(videoStream, duration, resolve, reject);
        }

        streamProcess = spawn('gst-launch-1.0', gstCommand.slice(1), {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Pipe del video stream al proceso
        videoStream.pipe(streamProcess.stdin);

        streamProcess.on('close', (code) => {
            console.log(`Proceso de stream terminado con código ${code}`);
            resolve();
        });

        streamProcess.on('error', (error) => {
            console.error('Error en el proceso de stream:', error);
            reject(error);
        });

        // Timeout basado en la duración del video
        setTimeout(() => {
            if (streamProcess) {
                streamProcess.kill();
            }
            resolve();
        }, (parseInt(duration) + 5) * 1000);
    });
}

// Implementación básica usando sockets para SRT (fallback)
function streamWithNodeSRT(videoStream, duration, resolve, reject) {
    const net = require('net');
    const url = require('url');
    
    try {
        // Parse SRT URL
        const parsedUrl = url.parse(SRT_URL.replace('srt://', 'tcp://'));
        const host = parsedUrl.hostname;
        const port = parsedUrl.port;
        
        const socket = net.createConnection(port, host, () => {
            console.log('Conectado al servidor SRT');
            
            // Pipe video stream al socket
            videoStream.pipe(socket);
        });

        socket.on('error', (error) => {
            console.error('Error de conexión SRT:', error);
            reject(error);
        });

        socket.on('close', () => {
            console.log('Conexión SRT cerrada');
            resolve();
        });

        // Timeout
        setTimeout(() => {
            socket.destroy();
            resolve();
        }, (parseInt(duration) + 5) * 1000);

    } catch (error) {
        console.error('Error en streaming básico:', error);
        reject(error);
    }
}

// Verificar si GStreamer está disponible
function isGStreamerAvailable() {
    try {
        const { execSync } = require('child_process');
        execSync('which gst-launch-1.0', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// Función para pasar al siguiente video
function nextVideo() {
    currentVideoIndex = (currentVideoIndex + 1) % videoUrls.length;
}

// Rutas de la API
app.get('/', (req, res) => {
    res.json({
        status: isStreaming ? 'streaming' : 'stopped',
        currentVideo: currentVideoIndex + 1,
        totalVideos: videoUrls.length,
        currentUrl: videoUrls[currentVideoIndex]
    });
});

app.post('/start', async (req, res) => {
    if (isStreaming) {
        return res.json({ message: 'Stream ya está activo' });
    }
    
    startStreaming();
    res.json({ message: 'Stream iniciado' });
});

app.post('/stop', (req, res) => {
    isStreaming = false;
    if (streamProcess) {
        streamProcess.kill();
        streamProcess = null;
    }
    res.json({ message: 'Stream detenido' });
});

app.post('/next', (req, res) => {
    if (streamProcess) {
        streamProcess.kill();
    }
    nextVideo();
    res.json({ 
        message: 'Cambiando al siguiente video',
        nextVideo: currentVideoIndex + 1,
        nextUrl: videoUrls[currentVideoIndex]
    });
});

app.get('/playlist', (req, res) => {
    res.json({
        videos: videoUrls.map((url, index) => ({
            index: index + 1,
            url: url,
            active: index === currentVideoIndex
        }))
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Videos en playlist: ${videoUrls.length}`);
    console.log('Endpoints disponibles:');
    console.log('  GET  / - Estado del stream');
    console.log('  POST /start - Iniciar stream');
    console.log('  POST /stop - Detener stream');
    console.log('  POST /next - Siguiente video');
    console.log('  GET  /playlist - Ver playlist');
});

// Manejo de cierre graceful
process.on('SIGINT', () => {
    console.log('Cerrando servidor...');
    isStreaming = false;
    if (streamProcess) {
        streamProcess.kill();
    }
    process.exit();
});
