const express = require('express');
const ytdl = require('ytdl-core');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar variables de entorno para ytdl
process.env.YTDL_NO_UPDATE = 'true';

// Lista de videos de YouTube (IDs extraídos)
const videoIds = [
    'BR3NFEXuSv0',
    'XOt3Rgs-tt0', 
    'nD2TZahdAJY',
    'lKgDhWCEfQo',
    '4uwZ-80XAqw',
    'NRQ7Kv7-8Hs',
    'rzDrGSWteZg'
];

// URL del stream SRT
const SRT_URL = 'srt://rtmp.livepeer.com:2935?streamid=95e4-urol-igfh-cehi';

let currentVideoIndex = 0;
let isStreaming = false;
let streamProcess = null;

// Configurar agentes HTTP con headers personalizados
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 5
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 5
});

// Headers para simular un navegador real
const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
};

// Configurar ytdl con opciones anti-bloqueo
const ytdlOptions = {
    requestOptions: {
        agent: httpsAgent,
        headers: browserHeaders,
        timeout: 30000
    },
    quality: 'highest',
    filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio
};

// Función para obtener información del video con reintentos
async function getVideoInfo(videoId, retries = 3) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Intento ${attempt}/${retries} para video ${videoId}`);
            
            // Rotar User-Agent para cada intento
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            ];
            
            const currentOptions = {
                ...ytdlOptions,
                requestOptions: {
                    ...ytdlOptions.requestOptions,
                    headers: {
                        ...browserHeaders,
                        'User-Agent': userAgents[attempt % userAgents.length]
                    }
                }
            };

            const info = await ytdl.getInfo(videoUrl, currentOptions);
            
            return {
                title: info.videoDetails.title,
                duration: info.videoDetails.lengthSeconds,
                formats: info.formats,
                videoUrl: videoUrl
            };
            
        } catch (error) {
            console.error(`Intento ${attempt} falló:`, error.message);
            
            if (attempt === retries) {
                // Último intento: usar método alternativo
                return await getVideoInfoAlternative(videoId);
            }
            
            // Esperar antes del siguiente intento
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
    
    return null;
}

// Método alternativo usando yt-dlp API o scraping básico
async function getVideoInfoAlternative(videoId) {
    try {
        console.log(`Usando método alternativo para ${videoId}`);
        
        // Usar API pública alternativa (ejemplo: invidious)
        const response = await fetch(`https://invidio.us/api/v1/videos/${videoId}`, {
            headers: browserHeaders
        });
        
        if (response.ok) {
            const data = await response.json();
            return {
                title: data.title,
                duration: data.lengthSeconds,
                formats: [], // Se llenará después
                videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                alternative: true
            };
        }
    } catch (error) {
        console.error('Método alternativo falló:', error.message);
    }
    
    // Fallback: información básica
    return {
        title: `Video ${videoId}`,
        duration: 300, // 5 minutos por defecto
        formats: [],
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        fallback: true
    };
}

// Función para obtener stream del video con múltiples intentos
async function getVideoStream(videoInfo, retries = 3) {
    if (videoInfo.fallback) {
        throw new Error('No se puede obtener stream de video fallback');
    }
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Obteniendo stream, intento ${attempt}/${retries}`);
            
            const stream = ytdl(videoInfo.videoUrl, {
                ...ytdlOptions,
                begin: Date.now()
            });
            
            return stream;
            
        } catch (error) {
            console.error(`Error obteniendo stream, intento ${attempt}:`, error.message);
            
            if (attempt === retries) {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
        }
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
        const currentVideoId = videoIds[currentVideoIndex];
        console.log(`\n=== Streaming video ${currentVideoIndex + 1}/${videoIds.length}: ${currentVideoId} ===`);

        try {
            // Obtener información del video
            const videoInfo = await getVideoInfo(currentVideoId);
            if (!videoInfo) {
                console.error('No se pudo obtener información del video, saltando...');
                nextVideo();
                continue;
            }

            console.log(`Título: ${videoInfo.title}`);
            console.log(`Duración: ${videoInfo.duration} segundos`);
            
            if (videoInfo.fallback) {
                console.log('⚠️ Usando información de fallback');
                // Esperar tiempo de fallback y continuar
                await new Promise(resolve => setTimeout(resolve, videoInfo.duration * 1000));
            } else {
                // Obtener stream del video
                const videoStream = await getVideoStream(videoInfo);
                
                // Hacer streaming
                await streamVideo(videoStream, videoInfo.duration);
            }

        } catch (error) {
            console.error('Error en el streaming:', error.message);
        }

        nextVideo();
        
        // Pausa entre videos
        console.log('Esperando antes del siguiente video...');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

// Función para hacer stream del video
function streamVideo(videoStream, duration) {
    return new Promise((resolve, reject) => {
        console.log('Iniciando transmisión...');
        
        // Usar implementación básica con socket TCP
        streamWithSocket(videoStream, duration, resolve, reject);
    });
}

// Implementación usando socket TCP directo
function streamWithSocket(videoStream, duration, resolve, reject) {
    const net = require('net');
    
    try {
        // Parsear URL SRT manualmente
        const host = 'rtmp.livepeer.com';
        const port = 2935;
        
        console.log(`Conectando a ${host}:${port}`);
        
        const socket = net.createConnection(port, host, () => {
            console.log('✅ Conectado al servidor SRT');
            
            // Enviar handshake SRT básico si es necesario
            const streamId = '95e4-urol-igfh-cehi';
            
            // Pipe video stream al socket
            videoStream.pipe(socket);
            
            videoStream.on('error', (error) => {
                console.error('Error en video stream:', error.message);
                socket.destroy();
                reject(error);
            });
        });

        socket.on('error', (error) => {
            console.error('❌ Error de conexión SRT:', error.message);
            reject(error);
        });

        socket.on('close', () => {
            console.log('🔌 Conexión SRT cerrada');
            resolve();
        });

        // Timeout basado en duración
        const timeout = setTimeout(() => {
            console.log('⏰ Timeout alcanzado, cerrando conexión');
            socket.destroy();
            resolve();
        }, (parseInt(duration) + 10) * 1000);

        socket.on('close', () => {
            clearTimeout(timeout);
        });

    } catch (error) {
        console.error('Error configurando socket:', error.message);
        reject(error);
    }
}

// Función para pasar al siguiente video
function nextVideo() {
    currentVideoIndex = (currentVideoIndex + 1) % videoIds.length;
    console.log(`➡️ Cambiando a video ${currentVideoIndex + 1}: ${videoIds[currentVideoIndex]}`);
}

// Rutas de la API
app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        status: isStreaming ? 'streaming' : 'stopped',
        currentVideo: currentVideoIndex + 1,
        totalVideos: videoIds.length,
        currentVideoId: videoIds[currentVideoIndex],
        uptime: process.uptime()
    });
});

app.post('/start', async (req, res) => {
    if (isStreaming) {
        return res.json({ message: 'Stream ya está activo' });
    }
    
    console.log('🚀 Iniciando stream por petición API');
    startStreaming();
    res.json({ message: 'Stream iniciado' });
});

app.post('/stop', (req, res) => {
    console.log('🛑 Deteniendo stream por petición API');
    isStreaming = false;
    if (streamProcess) {
        streamProcess.kill();
        streamProcess = null;
    }
    res.json({ message: 'Stream detenido' });
});

app.post('/next', (req, res) => {
    console.log('⏭️ Saltando al siguiente video por petición API');
    if (streamProcess) {
        streamProcess.kill();
    }
    nextVideo();
    res.json({ 
        message: 'Cambiando al siguiente video',
        nextVideo: currentVideoIndex + 1,
        nextVideoId: videoIds[currentVideoIndex]
    });
});

app.get('/playlist', (req, res) => {
    res.json({
        videos: videoIds.map((id, index) => ({
            index: index + 1,
            videoId: id,
            url: `https://youtu.be/${id}`,
            active: index === currentVideoIndex
        }))
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`\n🚀 Servidor ejecutándose en puerto ${PORT}`);
    console.log(`📺 Videos en playlist: ${videoIds.length}`);
    console.log(`🎯 Stream SRT: ${SRT_URL}`);
    console.log('\n📡 Endpoints disponibles:');
    console.log('  GET  / - Estado del stream');
    console.log('  POST /start - Iniciar stream');
    console.log('  POST /stop - Detener stream');
    console.log('  POST /next - Siguiente video');
    console.log('  GET  /playlist - Ver playlist');
    console.log('  GET  /health - Estado del servidor');
    console.log('\n✨ Listo para streaming!');
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rechazada:', reason);
});

// Manejo de cierre graceful
process.on('SIGINT', () => {
    console.log('\n🔄 Cerrando servidor...');
    isStreaming = false;
    if (streamProcess) {
        streamProcess.kill();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🔄 Servidor terminado...');
    isStreaming = false;
    if (streamProcess) {
        streamProcess.kill();
    }
    process.exit(0);
});
