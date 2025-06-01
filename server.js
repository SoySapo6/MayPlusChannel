const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');

const app = express();
const PORT = 3000;

// URLs de YouTube
const YOUTUBE_URLS = [
    'https://youtu.be/BR3NFEXuSv0?si=mSCaAzM4r6NjbC5L',
    'https://youtu.be/XOt3Rgs-tt0?si=RU86-8VqLKJ3TH60',
    'https://youtu.be/nD2TZahdAJY?si=3DfZBqXeEhAsgQH8',
    'https://youtu.be/lKgDhWCEfQo?si=6mD0EbDePrs_EAiI',
    'https://youtu.be/4uwZ-80XAqw?si=b62G5uNlWCdHBcnT',
    'https://youtu.be/NRQ7Kv7-8Hs?si=kFxtzMTvOwVFRx84',
    'https://youtu.be/rzDrGSWteZg?si=CqsE3ffZU5H0Mnyg'
];

// URL de destino SRT
const SRT_OUTPUT = 'srt://rtmp.livepeer.com:2935?streamid=95e4-urol-igfh-cehi';

// Directorio temporal para videos
const TEMP_DIR = './temp_videos';

// Crear directorio temporal si no existe
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

let currentStream = null;
let isStreaming = false;

// Función para limpiar el nombre del archivo
function sanitizeFilename(filename) {
    return filename.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
}

// Función para obtener URL de stream directo de YouTube
async function getYouTubeStreamUrl(url) {
    try {
        console.log(`Obteniendo stream URL para: ${url}`);
        
        // Validar y limpiar URL
        const videoId = ytdl.getVideoID(url);
        const info = await ytdl.getInfo(videoId);
        
        // Buscar formato de video apropiado (720p o menor)
        const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
        let selectedFormat = formats.find(format => 
            format.height && format.height <= 720 && format.height >= 480
        ) || formats.find(format => 
            format.qualityLabel && format.qualityLabel.includes('720p')
        ) || formats[0]; // Fallback al primer formato disponible
        
        if (!selectedFormat) {
            throw new Error('No se encontró formato de video compatible');
        }
        
        console.log(`Formato seleccionado: ${selectedFormat.qualityLabel || 'Desconocido'}`);
        console.log(`URL de stream obtenida exitosamente`);
        
        return {
            url: selectedFormat.url,
            title: info.videoDetails.title,
            duration: info.videoDetails.lengthSeconds
        };
        
    } catch (error) {
        console.error(`Error obteniendo stream URL: ${error.message}`);
        throw error;
    }
}

// Función para transmitir video directamente desde YouTube a SRT
function streamYouTubeToSRT(streamData) {
    return new Promise((resolve, reject) => {
        console.log(`Transmitiendo: ${streamData.title} -> ${SRT_OUTPUT}`);
        
        const ffmpeg = spawn('ffmpeg', [
            '-i', streamData.url,           // Input URL directa de YouTube
            '-c:v', 'libx264',             // Video codec
            '-preset', 'veryfast',          // Encoding preset para velocidad
            '-tune', 'zerolatency',         // Optimizar para baja latencia
            '-c:a', 'aac',                 // Audio codec
            '-b:a', '128k',                // Audio bitrate
            '-b:v', '2000k',               // Video bitrate
            '-maxrate', '2500k',           // Max bitrate
            '-bufsize', '5000k',           // Buffer size
            '-f', 'mpegts',                // Output format
            '-y',                          // Overwrite output
            SRT_OUTPUT                      // SRT destination
        ]);

        ffmpeg.stdout.on('data', (data) => {
            console.log(`FFmpeg stdout: ${data}`);
        });

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();
            // Solo mostrar líneas importantes de FFmpeg para no saturar logs
            if (output.includes('frame=') || output.includes('error') || output.includes('Error')) {
                console.log(`FFmpeg: ${output.trim()}`);
            }
        });

        ffmpeg.on('close', (code) => {
            console.log(`FFmpeg terminó con código: ${code} para: ${streamData.title}`);
            resolve(code);
        });

        ffmpeg.on('error', (error) => {
            console.error(`Error en FFmpeg: ${error}`);
            reject(error);
        });

        // Guardar referencia para poder detenerlo
        currentStream = ffmpeg;
    });
}

// Función para limpiar archivos temporales
function cleanupTempFiles() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        files.forEach(file => {
            fs.unlinkSync(path.join(TEMP_DIR, file));
        });
        console.log('Archivos temporales limpiados');
    } catch (error) {
        console.error('Error limpiando archivos temporales:', error);
    }
}

// Función principal para procesar todos los videos
async function startStreaming() {
    if (isStreaming) {
        console.log('Ya hay un stream en proceso');
        return;
    }

    isStreaming = true;
    console.log('Iniciando streaming de videos...');

    try {
        for (let i = 0; i < YOUTUBE_URLS.length; i++) {
            const url = YOUTUBE_URLS[i];
            console.log(`\n--- Procesando video ${i + 1}/${YOUTUBE_URLS.length} ---`);
            
            // Obtener URL de stream directo
            const streamData = await getYouTubeStreamUrl(url);
            
            // Transmitir video directamente
            await streamYouTubeToSRT(streamData);
            
            console.log(`Video "${streamData.title}" transmitido exitosamente\n`);
            
            // Pequeña pausa entre videos
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log('Todos los videos han sido transmitidos');
        
    } catch (error) {
        console.error('Error durante el streaming:', error);
    } finally {
        isStreaming = false;
        currentStream = null;
        console.log('Streaming finalizado');
    }
}

// Función para detener el stream actual
function stopStreaming() {
    if (currentStream) {
        currentStream.kill();
        currentStream = null;
    }
    isStreaming = false;
    cleanupTempFiles();
    console.log('Streaming detenido');
}

// Rutas de la API
app.get('/', (req, res) => {
    res.json({
        message: 'YouTube to SRT Streaming Server',
        status: isStreaming ? 'streaming' : 'idle',
        videos: YOUTUBE_URLS.length,
        destination: SRT_OUTPUT
    });
});

app.post('/start', (req, res) => {
    if (isStreaming) {
        return res.json({ 
            success: false, 
            message: 'Ya hay un stream en proceso' 
        });
    }

    startStreaming();
    res.json({ 
        success: true, 
        message: 'Streaming iniciado' 
    });
});

app.post('/stop', (req, res) => {
    stopStreaming();
    res.json({ 
        success: true, 
        message: 'Streaming detenido' 
    });
});

app.get('/status', (req, res) => {
    res.json({
        isStreaming,
        currentVideo: isStreaming ? 'En proceso...' : 'Ninguno',
        totalVideos: YOUTUBE_URLS.length
    });
});

// Manejo de señales para limpieza
process.on('SIGINT', () => {
    console.log('\nRecibida señal SIGINT, cerrando servidor...');
    stopStreaming();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nRecibida señal SIGTERM, cerrando servidor...');
    stopStreaming();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
    console.log(`Destino SRT: ${SRT_OUTPUT}`);
    console.log(`Videos a procesar: ${YOUTUBE_URLS.length}`);
    console.log('\nEndpoints disponibles:');
    console.log('  GET  / - Información del servidor');
    console.log('  POST /start - Iniciar streaming');
    console.log('  POST /stop - Detener streaming');
    console.log('  GET  /status - Estado actual');
});

module.exports = app;
