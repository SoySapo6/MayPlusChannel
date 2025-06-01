const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Función para descargar video con yt-dlp
function downloadVideo(url) {
    return new Promise((resolve, reject) => {
        console.log(`Descargando: ${url}`);
        
        const ytdlp = spawn('yt-dlp', [
            '--format', 'best[height<=720]',
            '--output', `${TEMP_DIR}/%(title)s.%(ext)s`,
            '--no-playlist',
            url
        ]);

        let filename = '';
        
        ytdlp.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`yt-dlp stdout: ${output}`);
            
            // Buscar el nombre del archivo descargado
            const match = output.match(/\[download\] Destination: (.+)/);
            if (match) {
                filename = match[1];
            }
        });

        ytdlp.stderr.on('data', (data) => {
            console.log(`yt-dlp stderr: ${data}`);
        });

        ytdlp.on('close', (code) => {
            if (code === 0) {
                // Si no capturamos el filename del stdout, intentar encontrarlo
                if (!filename) {
                    const files = fs.readdirSync(TEMP_DIR);
                    if (files.length > 0) {
                        filename = path.join(TEMP_DIR, files[files.length - 1]);
                    }
                }
                console.log(`Video descargado exitosamente: ${filename}`);
                resolve(filename);
            } else {
                reject(new Error(`yt-dlp falló con código: ${code}`));
            }
        });

        ytdlp.on('error', (error) => {
            reject(error);
        });
    });
}

// Función para transmitir video via FFmpeg a SRT
function streamVideoToSRT(videoPath) {
    return new Promise((resolve, reject) => {
        console.log(`Transmitiendo: ${videoPath} -> ${SRT_OUTPUT}`);
        
        const ffmpeg = spawn('ffmpeg', [
            '-re',                          // Leer input a su frame rate nativo
            '-i', videoPath,                // Input file
            '-c:v', 'libx264',             // Video codec
            '-preset', 'veryfast',          // Encoding preset para velocidad
            '-tune', 'zerolatency',         // Optimizar para baja latencia
            '-c:a', 'aac',                 // Audio codec
            '-b:a', '128k',                // Audio bitrate
            '-f', 'mpegts',                // Output format
            SRT_OUTPUT                      // SRT destination
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
            console.error(`Error en FFmpeg: ${error}`);
            reject(error);
        });

        return ffmpeg;
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
        for (const url of YOUTUBE_URLS) {
            console.log(`\n--- Procesando video ${YOUTUBE_URLS.indexOf(url) + 1}/${YOUTUBE_URLS.length} ---`);
            
            // Descargar video
            const videoPath = await downloadVideo(url);
            
            // Transmitir video
            await streamVideoToSRT(videoPath);
            
            // Limpiar archivo después de transmitir
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
                console.log(`Archivo eliminado: ${videoPath}`);
            }
            
            console.log('Video transmitido exitosamente\n');
        }
        
        console.log('Todos los videos han sido transmitidos');
        
    } catch (error) {
        console.error('Error durante el streaming:', error);
    } finally {
        isStreaming = false;
        cleanupTempFiles();
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
