const chalk = require("chalk");
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");
const keepAlive = require("./server");
const WebSocket = require('ws');

console.clear();

// ตั้งค่า
const PHONE = process.env.PHONE || "0959426013";
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;
const PROXY = `http://localhost:${PORT}/proxy`;

if (!TOKEN) {
    console.log(chalk.red('❌ ไม่พบ DISCORD_TOKEN'));
    process.exit(1);
}

console.log(chalk.cyan('\n='.repeat(50)));
console.log(chalk.cyan('Discord TrueWallet Voucher Bot'));
console.log(chalk.cyan('='.repeat(50)));
console.log(chalk.green(`📱 Phone: ${PHONE}`));
console.log(chalk.green(`🌐 Proxy: ${PROXY}`));
console.log(chalk.cyan('='.repeat(50) + '\n'));

// สถิติ
const stats = {
    total: 0,
    success: 0,
    failed: 0,
    amount: 0
};

// ดึงรูปภาพ
async function getImage(url) {
    try {
        const res = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 5000 
        });
        return res.data;
    } catch (err) {
        throw new Error('Cannot fetch image');
    }
}

// อ่าน QR Code
async function readQR(buffer) {
    try {
        const image = await jimp.read(buffer);
        const qr = new qrcode();
        
        return new Promise((resolve, reject) => {
            qr.callback = (err, value) => {
                if (err) return reject(err);
                resolve(value.result);
            };
            qr.decode(image.bitmap);
        });
    } catch (err) {
        throw new Error('Cannot read QR');
    }
}

// แยก Voucher Code
function getVoucherCode(text) {
    if (!text) return null;
    const match = text.match(/[?&]v=([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

// Redeem Voucher
async function redeemVoucher(code) {
    const start = Date.now();
    
    try {
        const url = `${PROXY}/${code}/${PHONE}`;
        const res = await axios.get(url, { 
            timeout: 12000,
            validateStatus: () => true 
        });
        
        const data = res.data;
        const duration = Date.now() - start;
        
        // Cloudflare Block
        if (data?.status?.code === 'CLOUDFLARE_BLOCK') {
            return { 
                error: true, 
                message: 'Cloudflare Block', 
                duration 
            };
        }
        
        // Success
        if (data?.status?.code === 'SUCCESS') {
            return {
                error: false,
                amount: data.data?.amount_baht || 0,
                owner: data.data?.owner_profile?.full_name || 'Unknown',
                duration
            };
        }
        
        // Failed
        return {
            error: true,
            message: data?.status?.code || data?.status?.message || 'Failed',
            duration
        };
        
    } catch (err) {
        return {
            error: true,
            message: err.message,
            duration: Date.now() - start
        };
    }
}

// Discord Client
class DiscordClient {
    constructor(token) {
        this.token = token;
        this.ws = null;
        this.heartbeat = null;
        this.seq = null;
    }

    connect(onMessage) {
        console.log(chalk.yellow('🔄 Connecting to Discord...'));
        
        this.ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

        this.ws.on('open', () => {
            console.log(chalk.green('✅ Connected to Discord\n'));
        });

        this.ws.on('message', (data) => {
            const payload = JSON.parse(data);
            const { op, d, s, t } = payload;

            if (s) this.seq = s;

            if (op === 10) {
                this.startHeartbeat(d.heartbeat_interval);
                this.identify();
            } else if (op === 0 && t === 'READY') {
                console.log(chalk.green('='.repeat(50)));
                console.log(chalk.green(`✅ Logged in as: ${d.user.username}`));
                console.log(chalk.green(`🆔 ID: ${d.user.id}`));
                console.log(chalk.green('='.repeat(50)));
                console.log(chalk.cyan('🤖 Bot is ready!\n'));
            } else if (op === 0 && t === 'MESSAGE_CREATE') {
                onMessage(d);
            }
        });

        this.ws.on('close', () => {
            console.log(chalk.red('❌ Disconnected'));
            clearInterval(this.heartbeat);
            setTimeout(() => this.connect(onMessage), 5000);
        });

        this.ws.on('error', (err) => {
            console.log(chalk.red(`💥 Error: ${err.message}`));
        });
    }

    startHeartbeat(interval) {
        this.heartbeat = setInterval(() => {
            if (this.ws?.readyState === 1) {
                this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
            }
        }, interval);
    }

    identify() {
        this.ws.send(JSON.stringify({
            op: 2,
            d: {
                token: this.token,
                properties: {
                    os: 'windows',
                    browser: 'chrome',
                    device: 'pc'
                }
            }
        }));
    }
}

// Main
async function main() {
    const client = new DiscordClient(TOKEN);
    const used = new Set();

    const handleMessage = async (msg) => {
        try {
            if (msg.author?.bot) return;

            let code = null;

            // จากข้อความ
            if (msg.content) {
                code = getVoucherCode(msg.content);
            }

            // จากรูปภาพ
            if (!code && msg.attachments?.length > 0) {
                for (const att of msg.attachments) {
                    if (att.content_type?.startsWith('image/')) {
                        try {
                            console.log(chalk.blue('🖼️  Reading QR...'));
                            const img = await getImage(att.url);
                            const qr = await readQR(img);
                            code = getVoucherCode(qr);
                            if (code) break;
                        } catch (err) {
                            console.log(chalk.red('❌ Cannot read QR'));
                        }
                    }
                }
            }

            // Redeem
            if (code && !used.has(code)) {
                used.add(code);
                stats.total++;

                console.log(chalk.yellow('\n' + '='.repeat(50)));
                console.log(chalk.yellow(`🎫 Voucher: ${code}`));
                console.log(chalk.cyan('⚡ Redeeming...'));

                const result = await redeemVoucher(code);

                if (result.error) {
                    stats.failed++;
                    console.log(chalk.red(`❌ ${result.message} (${result.duration}ms)`));
                } else {
                    stats.success++;
                    stats.amount += result.amount;
                    console.log(chalk.green(`✅ +${result.amount}฿ from ${result.owner}`));
                    console.log(chalk.cyan(`⚡ ${result.duration}ms`));
                    console.log(chalk.magenta(`💰 Total: ${stats.amount}฿`));
                }

                console.log(chalk.gray(`📊 ${stats.success}✅ / ${stats.failed}❌`));
                console.log(chalk.yellow('='.repeat(50) + '\n'));
            }

            // คำสั่ง
            if (msg.content === '!stats') {
                console.log(chalk.cyan('\n📊 Stats:'));
                console.log(chalk.gray(`Total: ${stats.total}`));
                console.log(chalk.green(`Success: ${stats.success}`));
                console.log(chalk.red(`Failed: ${stats.failed}`));
                console.log(chalk.magenta(`Amount: ${stats.amount}฿\n`));
            }

        } catch (err) {
            console.log(chalk.red(`❌ Error: ${err.message}`));
        }
    };

    client.connect(handleMessage);
}

// Start
keepAlive();

setTimeout(() => {
    console.log(chalk.cyan('🚀 Starting bot...\n'));
    main();
}, 2000);

// Error Handlers
process.on('uncaughtException', (err) => {
    console.log(chalk.red(`💥 ${err.message}`));
});

process.on('unhandledRejection', (err) => {
    console.log(chalk.red(`💥 ${err.message}`));
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('\n📴 Shutting down...'));
    console.log(chalk.cyan('📊 Final Stats:'));
    console.log(chalk.gray(`Total: ${stats.total}`));
    console.log(chalk.green(`Success: ${stats.success}`));
    console.log(chalk.red(`Failed: ${stats.failed}`));
    console.log(chalk.magenta(`Amount: ${stats.amount}฿\n`));
    process.exit(0);
});
