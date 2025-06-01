const express = require('express');
const https = require('https');
const http = require('http');
const net = require('net');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Lista de videos de YouTube
const videoIds = [
    'BR3NFEXuSv0',
    'XOt3Rgs-tt0', 
    'nD2TZahdAJY',
    'lKgDhWCEfQo',
    '4uwZ-80XAqw',
    'NRQ7Kv7-8Hs',
    'rzDrGSWteZg'
];

// Configuración del stream
const SRT_CONFIG = {
    host: 'rtmp.livepeer.com',
    port: 2935,
    streamId: '95e4-urol-igfh-cehi'
};

let currentVideoIndex = 0;
let isStreaming = false;
let streamSocket = null;
let stats = {
    totalVideos: 0,
    errors: 0,
    connections: 0,
    startTime: Date.now()
};

// Estrategia 1: Usar APIs alternativas para obtener URLs de video
const INVIDIOUS_INSTANCES = [
    'invidio.us',
    'yewtu.be',
    'inv.riverside.rocks',
    'invidious.snopyta.org'
];

// Estrategia 2: URLs de video de prueba (si no funciona YouTube)
const FALLBACK_STREAMS = [
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4'
];

// Función para obtener información del video usando APIs alternativas
async function getVideoInfo(videoId) {
    console.log(`🔍 Buscando info para video: ${videoId}`);
    
    // Intentar con diferentes instancias de Invidious
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            console.log(`Probando instancia: ${instance}`);
            
            const response = await fetchWithTimeout(`https://${instance}/api/v1/videos/${videoId}`, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                
                // Buscar formato de video adecuado
                const videoFormat = data.formatStreams?.find(f => 
                    f.container === 'mp4' && f.resolution && f.url
                ) || data.adaptiveFormats?.find(f => 
                    f.container === 'mp4' && f.type?.includes('video') && f.url
                );
                
                if (videoFormat) {
                    return {
                        title: data.title,
                        duration: data.lengthSeconds,
                        videoUrl: videoFormat.url,
                        source: 'invidious',
                        instance: instance
                    };
                }
            }
        } catch (error) {
            console.log(`❌ Error con ${instance}: ${error.message}`);
            continue;
        }
    }
    
    // Fallback: usar videos de prueba
    console.log('🔄 Usando video de fallback');
    const fallbackIndex = Math.floor(Math.random() * FALLBACK_STREAMS.length);
    return {
        title: `Video de prueba ${videoId}`,
        duration: 300,
        videoUrl: FALLBACK_STREAMS[fallbackIndex],
        source: 'fallback'
    };
}

// Función auxiliar para fetch con timeout
async function fetchWithTimeout(url, options = {}) {
    const { timeout = 8000 } = options;
    
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Función para hacer streaming del video
async function streamVideo(videoInfo) {
    return new Promise((resolve, reject) => {
        console.log(`🎬 Iniciando stream: ${videoInfo.title}`);
        console.log(`📺 Fuente: ${videoInfo.source}`);
        console.log(`⏱️ Duración: ${videoInfo.duration}s`);
        
        // Conectar al servidor SRT
        streamSocket = net.createConnection(SRT_CONFIG.port, SRT_CONFIG.host, () => {
            console.log(`✅ Conectado a SRT: ${SRT_CONFIG.host}:${SRT_CONFIG.port}`);
            stats.connections++;
            
            // Descargar y transmitir el video
            streamVideoContent(videoInfo.videoUrl, streamSocket, videoInfo.duration, resolve, reject);
        });
        
        streamSocket.on('error', (error) => {
            console.error(`❌ Error SRT: ${error.message}`);
            stats.errors++;
            reject(error);
        });
        
        streamSocket.on('close', () => {
            console.log('🔌 Conexión SRT cerrada');
            resolve();
        });
    });
}

// Función para descargar y transmitir contenido de video
function streamVideoContent(videoUrl, socket, duration, resolve, reject) {
    console.log(`📥 Descargando video desde: ${videoUrl}`);
    
    const url = new URL(videoUrl);
    const httpModule = url.protocol === 'https:' ? https : http;
    
    const request = httpModule.request(videoUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Range': 'bytes=0-'
        }
    }, (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
            console.log(`📡 Transmitiendo datos (${response.statusCode})`);
            
            // Pipe el contenido del video al socket SRT
            response.pipe(socket, { end: false });
            
            response.on('end', () => {
                console.log('✅ Descarga completada');
                socket.end();
                resolve();
            });
            
        } else if (response.statusCode >= 300 && response.statusCode < 400) {
            // Manejar redirecciones
            const location = response.headers.location;
            if (location) {
                console.log(`🔄 Redirigiendo a: ${location}`);
                streamVideoContent(location, socket, duration, resolve, reject);
                return;
            }
        } else {
            console.error(`❌ Error HTTP: ${response.statusCode}`);
            reject(new Error(`HTTP ${response.statusCode}`));
        }
    });
    
    request.on('error', (error) => {
        console.error(`❌ Error de descarga: ${error.message}`);
        stats.errors++;
        reject(error);
    });
    
    // Timeout para videos muy largos
    request.setTimeout((duration + 30) * 1000, () => {
        console.log('⏰ Timeout de descarga');
        request.destroy();
        resolve();
    });
    
    request.end();
}

// Función principal de streaming
async function startStreaming() {
    if (isStreaming) {
        console.log('⚠️ Stream ya está activo');
        return;
    }
    
    isStreaming = true;
    stats.startTime = Date.now();
    console.log('🚀 Iniciando streaming loop...');
    
    while (isStreaming) {
        const videoId = videoIds[currentVideoIndex];
        console.log(`\n🎯 Video ${currentVideoIndex + 1}/${videoIds.length}: ${videoId}`);
        
        try {
            // Obtener información del video
            const videoInfo = await getVideoInfo(videoId);
            if (!videoInfo) {
                console.error('❌ No se pudo obtener info del video');
                nextVideo();
                continue;
            }
            
            // Transmitir el video
            await streamVideo(videoInfo);
            stats.totalVideos++;
            
        } catch (error) {
            console.error(`❌ Error en streaming: ${error.message}`);
            stats.errors++;
        }
        
        // Siguiente video
        nextVideo();
        
        // Pausa entre videos
        if (isStreaming) {
            console.log('⏸️ Pausa entre videos (5s)...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    console.log('🛑 Streaming terminado');
}

// Función para cambiar al siguiente video
function nextVideo() {
    currentVideoIndex = (currentVideoIndex + 1) % videoIds.length;
    console.log(`➡️ Siguiente: ${videoIds[currentVideoIndex]}`);
}

// Middleware
app.use(express.json());

// Rutas de la API
app.get('/', (req, res) => {
    const uptime = Date.now() - stats.startTime;
    res.json({
        status: isStreaming ? 'streaming' : 'stopped',
        currentVideo: {
            index: currentVideoIndex + 1,
            id: videoIds[currentVideoIndex],
            total: videoIds.length
        },
        stats: {
            ...stats,
            uptime: Math.floor(uptime / 1000),
            successRate: stats.totalVideos / (stats.totalVideos + stats.errors) || 0
        },
        server: 'alternative-streamer'
    });
});

app.post('/start', (req, res) => {
    if (isStreaming) {
        return res.json({ 
            success: false, 
            message: 'Stream ya está activo' 
        });
    }
    
    console.log('🎬 Iniciando stream por API...');
    startStreaming().catch(err => {
        console.error('Error en stream:', err);
        isStreaming = false;
    });
    
    res.json({ 
        success: true, 
        message: 'Stream iniciado' 
    });
});

app.post('/stop', (req, res) => {
    console.log('🛑 Deteniendo stream...');
    isStreaming = false;
    
    if (streamSocket) {
        streamSocket.destroy();
        streamSocket = null;
    }
    
    res.json({ 
        success: true, 
        message: 'Stream detenido' 
    });
});

app.post('/next', (req, res) => {
    console.log('⏭️ Saltando video...');
    
    if (streamSocket) {
        streamSocket.destroy();
    }
    
    nextVideo();
    
    res.json({
        success: true,
        message: 'Cambiado al siguiente video',
        next: {
            index: currentVideoIndex + 1,
            id: videoIds[currentVideoIndex]
        }
    });
});

app.get('/playlist', (req, res) => {
    res.json({
        videos: videoIds.map((id, index) => ({
            index: index + 1,
            id: id,
            url: `https://youtu.be/${id}`,
            active: index === currentVideoIndex
        })),
        fallbackStreams: FALLBACK_STREAMS.length
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        streaming: isStreaming,
        stats: stats
    });
});

app.get('/test', async (req, res) => {
    const testVideoId = videoIds[0];
    console.log(`🧪 Probando video: ${testVideoId}`);
    
    try {
        const videoInfo = await getVideoInfo(testVideoId);
        res.json({
            success: true,
            videoInfo: videoInfo,
            message: 'Test exitoso'
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            message: 'Test falló'
        });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`\n🚀 Servidor alternativo en puerto ${PORT}`);
    console.log(`📺 Videos: ${videoIds.length}`);
    console.log(`🎯 SRT: ${SRT_CONFIG.host}:${SRT_CONFIG.port}`);
    console.log(`🔧 Fallbacks: ${FALLBACK_STREAMS.length}`);
    console.log('\n📡 Endpoints:');
    console.log('  GET  / - Estado');
    console.log('  POST /start - Iniciar');
    console.log('  POST /stop - Detener');
    console.log('  POST /next - Siguiente');
    console.log('  GET  /playlist - Lista');
    console.log('  GET  /health - Salud');
    console.log('  GET  /test - Probar video');
    console.log('\n🌟 Servidor listo!');
});

// Manejo de errores
process.on('uncaughtException', (error) => {
    console.error('💥 Error crítico:', error.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 Promise rechazada:', reason);
});

// Cierre graceful
process.on('SIGINT', () => {
    console.log('\n👋 Cerrando servidor...');
    isStreaming = false;
    if (streamSocket) streamSocket.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Terminando servidor...');
    isStreaming = false;
    if (streamSocket) streamSocket.destroy();
    process.exit(0);
});
