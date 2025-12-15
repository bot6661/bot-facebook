const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');

const server = express();

// ============================================
// ⚡ Connection Pooling (เพิ่มความเร็ว)
// ============================================
const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10
});

// ============================================
// 🔧 Middleware
// ============================================
server.use(express.json());

// CORS Headers
server.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

// ============================================
// 🏠 Homepage
// ============================================
server.all('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'Discord Voucher Bot + Proxy Server ⚡',
        version: '2.0.0',
        endpoints: {
            home: '/',
            health: '/health',
            proxy: '/topup/angpaofree/before/:voucher/:phone',
            stats: '/stats'
        },
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 💓 Health Check
// ============================================
server.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        memory: {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
        },
        node: process.version,
        platform: process.platform
    });
});

// ============================================
// 📊 Statistics
// ============================================
const proxyStats = {
    total: 0,
    success: 0,
    failed: 0,
    cloudflare: 0,
    errors: 0,
    startTime: Date.now()
};

server.get('/stats', (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - proxyStats.startTime) / 1000);
    const uptimeMinutes = Math.floor(uptimeSeconds / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    
    res.json({
        requests: {
            total: proxyStats.total,
            success: proxyStats.success,
            failed: proxyStats.failed,
            cloudflare: proxyStats.cloudflare,
            errors: proxyStats.errors
        },
        successRate: proxyStats.total > 0 
            ? `${((proxyStats.success / proxyStats.total) * 100).toFixed(2)}%` 
            : '0%',
        uptime: {
            seconds: uptimeSeconds,
            minutes: uptimeMinutes,
            hours: uptimeHours,
            formatted: `${uptimeHours}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 🎯 Proxy Endpoint (TrueWallet) - เวอร์ชันเร็ว
// ============================================
server.get('/topup/angpaofree/before/:voucher/:phone', async (req, res) => {
    const { voucher, phone } = req.params;
    const startTime = Date.now();
    
    proxyStats.total++;
    
    console.log(`\n📨 [${new Date().toLocaleTimeString('th-TH')}] Proxy Request`);
    console.log(`   🎫 Voucher: ${voucher}`);
    console.log(`   📱 Phone: ${phone}`);
    
    // ⚡ Quick validation
    if (!voucher || !phone) {
        proxyStats.errors++;
        console.log(`   ❌ Missing parameters`);
        return res.status(400).json({
            status: { message: 'ERROR' },
            error: 'Missing voucher or phone parameter'
        });
    }
    
    // Validate voucher format (alphanumeric, 10-20 chars)
    if (!/^[a-zA-Z0-9]{10,20}$/.test(voucher)) {
        proxyStats.errors++;
        console.log(`   ❌ Invalid voucher format`);
        return res.status(400).json({
            status: { message: 'ERROR' },
            error: 'Invalid voucher format'
        });
    }
    
    // Headers (เหมือนเบราว์เซอร์)
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://gift.truemoney.com',
        'Referer': 'https://gift.truemoney.com/',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'DNT': '1',
        'Connection': 'keep-alive'
    };
    
    try {
        // ⚡ Call TrueWallet API
        const response = await axios.post(
            `https://gift.truemoney.com/campaign/vouchers/${voucher}/redeem`,
            {
                mobile: phone,
                voucher_hash: voucher
            },
            {
                headers,
                timeout: 7000, // ⚡ 7 วินาที (ลดจาก 10 วินาที)
                validateStatus: () => true,
                httpAgent,
                httpsAgent,
                maxRedirects: 0,
                decompress: true
            }
        );
        
        const duration = Date.now() - startTime;
        const data = response.data;
        
        // ตรวจสอบ Cloudflare Block
        if (typeof data === 'string' && (
            data.includes('cloudflare') || 
            data.includes('cf-browser-verification') ||
            data.includes('<!DOCTYPE') ||
            data.includes('<html')
        )) {
            proxyStats.cloudflare++;
            console.log(`   🛡️  Cloudflare Block (${duration}ms)`);
            return res.status(403).json({
                status: { message: 'CLOUDFLARE_BLOCK' },
                error: 'Blocked by Cloudflare Protection',
                duration
            });
        }
        
        // ตรวจสอบ response
        if (!data || typeof data !== 'object') {
            proxyStats.errors++;
            console.log(`   ❌ Invalid response (${duration}ms)`);
            return res.status(500).json({
                status: { message: 'ERROR' },
                error: 'Invalid response from TrueWallet',
                duration
            });
        }
        
        const statusMsg = data?.status?.message || data?.status?.code || 'UNKNOWN';
        
        // นับสถิติ
        if (statusMsg === 'SUCCESS' || response.status === 200) {
            proxyStats.success++;
            console.log(`   ✅ SUCCESS (${duration}ms)`);
        } else {
            proxyStats.failed++;
            console.log(`   ❌ ${statusMsg} (${duration}ms)`);
        }
        
        // Log response details
        if (data?.data?.amount_baht) {
            console.log(`   💰 Amount: ${data.data.amount_baht}฿`);
        }
        
        return res.status(response.status).json({
            ...data,
            _proxy: {
                duration,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        const duration = Date.now() - startTime;
        proxyStats.errors++;
        
        console.log(`   💥 Error: ${error.message} (${duration}ms)`);
        
        // จำแนกประเภท error
        let errorType = 'ERROR';
        let statusCode = 500;
        
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            errorType = 'TIMEOUT';
            statusCode = 504;
        } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            errorType = 'CONNECTION_ERROR';
            statusCode = 503;
        }
        
        return res.status(statusCode).json({
            status: { message: errorType },
            error: error.message,
            code: error.code,
            duration,
            timestamp: new Date().toISOString()
        });
    }
});

// ============================================
// 🚫 404 Handler
// ============================================
server.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Endpoint not found',
        path: req.path,
        availableEndpoints: {
            home: '/',
            health: '/health',
            proxy: '/topup/angpaofree/before/:voucher/:phone',
            stats: '/stats'
        }
    });
});

// ============================================
// 💥 Error Handler
// ============================================
server.use((error, req, res, next) => {
    console.error('💥 Server Error:', error);
    res.status(500).json({
        status: 'error',
        message: 'Internal server error',
        error: error.message
    });
});

// ============================================
// 🚀 Start Server
// ============================================
function keepAlive() {
    const PORT = process.env.PORT || 3000;
    
    server.listen(PORT, () => {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🌐 Server + Proxy running on port ${PORT}`);
        console.log(`🔗 Local: http://localhost:${PORT}`);
        console.log(`📡 Proxy: /topup/angpaofree/before/:voucher/:phone`);
        console.log(`📊 Stats: /stats`);
        console.log(`💓 Health: /health`);
        console.log(`${'='.repeat(60)}\n`);
        
        console.log(`⚡ Performance Optimizations:`);
        console.log(`   ✅ Connection Keep-Alive enabled`);
        console.log(`   ✅ HTTP Agent pooling enabled`);
        console.log(`   ✅ Response timeout: 7 seconds`);
        console.log(`   ✅ Max sockets: 50\n`);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('\n📴 Shutting down gracefully...');
        console.log(`📊 Final Stats:`);
        console.log(`   Total: ${proxyStats.total}`);
        console.log(`   Success: ${proxyStats.success}`);
        console.log(`   Failed: ${proxyStats.failed}`);
        console.log(`   Cloudflare: ${proxyStats.cloudflare}`);
        console.log(`   Errors: ${proxyStats.errors}`);
        process.exit(0);
    });
}
