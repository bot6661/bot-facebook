const express = require('express');
const axios = require('axios');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// สถิติ
const stats = {
    total: 0,
    success: 0,
    failed: 0,
    cloudflare: 0
};

// หน้าแรก
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'Discord Bot + Proxy Server Running! 🚀',
        uptime: Math.floor(process.uptime()),
        stats: stats
    });
});

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// Proxy Endpoint
app.get('/proxy/:voucher/:phone', async (req, res) => {
    const { voucher, phone } = req.params;
    
    stats.total++;
    console.log(`\n[${new Date().toLocaleTimeString()}] Redeem: ${voucher}`);
    
    if (!voucher || !phone) {
        stats.failed++;
        return res.status(400).json({ 
            status: { code: 'ERROR' },
            message: 'Missing parameters' 
        });
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `https://gift.truemoney.com/campaign/vouchers/${voucher}/redeem`,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            data: {
                mobile: phone,
                voucher_hash: voucher
            },
            timeout: 10000,
            validateStatus: () => true
        });

        const data = response.data;

        // ตรวจสอบ Cloudflare
        if (typeof data === 'string' || !data.status) {
            stats.cloudflare++;
            console.log('❌ Cloudflare Block');
            return res.json({
                status: { code: 'CLOUDFLARE_BLOCK' },
                message: 'Blocked by Cloudflare'
            });
        }

        // ตรวจสอบผลลัพธ์
        const code = data.status.code || data.status.message;
        
        if (code === 'SUCCESS') {
            stats.success++;
            console.log(`✅ SUCCESS - ${data.data?.amount_baht || 0}฿`);
        } else {
            stats.failed++;
            console.log(`❌ ${code}`);
        }

        return res.json(data);

    } catch (error) {
        stats.failed++;
        console.log(`💥 Error: ${error.message}`);
        
        return res.status(500).json({
            status: { code: 'ERROR' },
            message: error.message
        });
    }
});

// Start Server
function keepAlive() {
    const PORT = process.env.PORT || 3000;
    
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(50));
        console.log('🌐 Server + Proxy Running');
        console.log(`🔗 Port: ${PORT}`);
        console.log(`📡 Proxy: /proxy/:voucher/:phone`);
        console.log('='.repeat(50) + '\n');
    });
}

module.exports = keepAlive;
