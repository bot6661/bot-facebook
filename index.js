const chalk = require("chalk");
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");
const WebSocket = require('ws');

const keepAlive = require("./server.js");

console.clear();
process.env.TZ = "Asia/Bangkok";

console.log(chalk.cyan("\n===== TrueWallet Voucher Bot =====\n"));

const phone = process.env.PHONE;
const userToken = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!userToken || !phone || !WEBHOOK_URL) {
    console.error(chalk.red("Error: Missing required environment variables!"));
    process.exit(1);
}

// ===============================================
// 💬 ส่ง Webhook (ไม่รอ - เร็วสุด)
// ===============================================

function sendWebhook(embeds) {
    axios.post(WEBHOOK_URL, { embeds }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 2000
    }).catch(() => {});
}

// ===============================================
// 🖼️ Image Processing (เร็วสุด)
// ===============================================

async function getImageFromURL(url) {
    const response = await axios.get(url, { 
        responseType: "arraybuffer",
        timeout: 5000,
        maxContentLength: 10 * 1024 * 1024 // 10MB
    });
    return response.data;
}

async function decodeQRFromImage(imageBuffer) {
    const image = await jimp.read(imageBuffer);
    
    // ลองแค่ 2 วิธี (เร็วสุด)
    const attempts = [
        image, // ขนาดเดิม
        image.clone().resize(800, jimp.AUTO).greyscale() // ย่อ + ขาวดำ
    ];
    
    for (const img of attempts) {
        try {
            const qr = new qrcode();
            const result = await Promise.race([
                new Promise((resolve, reject) => {
                    qr.callback = (err, value) => err ? reject(err) : resolve(value.result);
                    qr.decode(img.bitmap);
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            ]);
            
            if (result) return result;
        } catch (e) {
            continue;
        }
    }
    
    throw new Error('No QR');
}

// ===============================================
// 💰 TrueWallet Voucher (เร็วสุด)
// ===============================================

class TrueWalletVoucher {
    constructor(phone) {
        this.phone = phone;
        this.PROXY_URL = 'https://truewalletproxy-755211536068837409.rcf2.deploys.app/api';
    }

    getVoucherCode(text) {
        if (!text) return null;
        const patterns = [
            /v=([a-zA-Z0-9]+)/,
            /vouchers\/([a-zA-Z0-9]+)/,
            /campaign\/\?v=([a-zA-Z0-9]+)/
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match?.[1]) return match[1];
        }
        return null;
    }

    async redeem(voucherCode) {
        try {
            const response = await axios.post(
                this.PROXY_URL,
                { mobile: this.phone, voucher: voucherCode },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'multilabxxxxxxxx'
                    },
                    timeout: 5000,
                    validateStatus: () => true
                }
            );

            const data = response.data;
            if (data?.status?.code === 'SUCCESS') {
                return {
                    success: true,
                    amount: Number(data.data.my_ticket.amount_baht.replace(/,/g, "")),
                    ownerName: data.data.owner_profile.full_name || 'Unknown'
                };
            }

            return {
                success: false,
                message: data?.status?.message || data?.status?.code || 'Failed'
            };
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }
}

// ===============================================
// 🤖 Discord Client
// ===============================================

class DiscordUserClient {
    constructor(token) {
        this.token = token;
        this.ws = null;
        this.heartbeatInterval = null;
        this.sessionId = null;
        this.sequence = null;
        this.reconnectAttempts = 0;
    }

    connect(messageHandler) {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === 1) this.ws.close();
        }

        this.ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

        this.ws.on('open', () => {
            console.log(chalk.green('✓ Connected'));
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
            const payload = JSON.parse(data);
            const { op, d, s, t } = payload;
            if (s) this.sequence = s;

            switch (op) {
                case 10:
                    this.startHeartbeat(d.heartbeat_interval);
                    if (this.sessionId && this.sequence) {
                        this.resume();
                    } else {
                        this.identify();
                    }
                    break;
                case 0:
                    if (t === 'READY') {
                        console.log(chalk.green(`✅ ${d.user.username}`));
                        this.sessionId = d.session_id;
                        sendWebhook([{
                            title: "🟢 Bot เริ่มทำงาน",
                            color: 0x00ff00,
                            fields: [
                                { name: "👤 Username", value: d.user.username, inline: true },
                                { name: "📱 Phone", value: phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2'), inline: true }
                            ],
                            timestamp: new Date().toISOString()
                        }]);
                    } else if (t === 'MESSAGE_CREATE') {
                        messageHandler(d);
                    }
                    break;
                case 11:
                    break;
                case 9:
                    this.sessionId = null;
                    this.sequence = null;
                    setTimeout(() => this.identify(), 1000);
                    break;
                case 7:
                    this.ws.close();
                    break;
            }
        });

        this.ws.on('close', () => {
            clearInterval(this.heartbeatInterval);
            if (this.reconnectAttempts < 10) {
                this.reconnectAttempts++;
                setTimeout(() => this.connect(messageHandler), 2000);
            }
        });

        this.ws.on('error', () => {});
    }

    startHeartbeat(interval) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === 1) {
                this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
            }
        }, interval);
    }

    identify() {
        setTimeout(() => {
            this.ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: this.token,
                    capabilities: 16381,
                    properties: { os: 'Linux', browser: 'Chrome', device: '' },
                    presence: { status: 'online', since: 0, activities: [], afk: false }
                }
            }));
        }, Math.random() * 500 + 200);
    }

    resume() {
        this.ws.send(JSON.stringify({
            op: 6,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence }
        }));
    }
}

// ===============================================
// 📊 Stats
// ===============================================

let totalEarned = 0;
let successCount = 0;
let failCount = 0;

// ===============================================
// 🚀 Main (เร็วสุด - ประมวลผลพร้อมกัน)
// ===============================================

async function main(phone, userToken) {
    const voucher = new TrueWalletVoucher(phone);
    const client = new DiscordUserClient(userToken);
    const redeemedVouchers = new Set();

    console.log(chalk.magenta(`🔧 Method: PROXY (Fast Mode)`));
    console.log(chalk.gray("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

    const handleMessage = async (message) => {
        if (message.author?.bot) return;

        const processVoucher = async (voucherCode, imageUrl = null, source = '') => {
            if (!voucherCode || redeemedVouchers.has(voucherCode)) return;
            
            redeemedVouchers.add(voucherCode);
            
            const detectTime = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
            const startTime = Date.now();
            
            const result = await voucher.redeem(voucherCode);
            const speed = ((Date.now() - startTime) / 1000).toFixed(2);
            
            if (result.success) {
                console.log(chalk.green(`✅ ${result.amount}฿ ${source}(${speed}s)`));
                totalEarned += result.amount;
                successCount++;
                
                sendWebhook([{
                    title: `✅ รีดีมสำเร็จ ${source}`,
                    color: 0x00ff00,
                    fields: [
                        { name: "💰 จำนวน", value: `${result.amount}฿`, inline: true },
                        { name: "👤 จาก", value: result.ownerName, inline: true },
                        { name: "⚡ ความเร็ว", value: `${speed}s`, inline: true },
                        { name: "🎫 Code", value: voucherCode, inline: false },
                        { name: "⏰ เวลาดัก", value: detectTime, inline: true },
                        { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                    ],
                    thumbnail: imageUrl ? { url: imageUrl } : undefined,
                    timestamp: new Date().toISOString()
                }]);
            } else {
                console.log(chalk.red(`❌ ${result.message} ${source}(${speed}s)`));
                failCount++;
                
                sendWebhook([{
                    title: `❌ รีดีมล้มเหลว ${source}`,
                    color: 0xff0000,
                    fields: [
                        { name: "📝 สาเหตุ", value: result.message, inline: false },
                        { name: "⚡ ความเร็ว", value: `${speed}s`, inline: true },
                        { name: "🎫 Code", value: voucherCode, inline: false },
                        { name: "⏰ เวลาดัก", value: detectTime, inline: true },
                        { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                    ],
                    thumbnail: imageUrl ? { url: imageUrl } : undefined,
                    timestamp: new Date().toISOString()
                }]);
            }
        };

        // ตรวจสอบข้อความ (เร็วสุด)
        if (message.content) {
            const voucherCode = voucher.getVoucherCode(message.content);
            if (voucherCode) {
                processVoucher(voucherCode, null, '');
            }
        }

        // ตรวจสอบรูปภาพทั้งหมดพร้อมกัน (Parallel)
        const imagePromises = [];

        // Attachments
        if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
                const isImage = 
                    attachment.content_type?.startsWith('image/') ||
                    attachment.filename?.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);
                
                if (isImage) {
                    imagePromises.push(
                        getImageFromURL(attachment.url)
                            .then(decodeQRFromImage)
                            .then(qr => {
                                const code = voucher.getVoucherCode(qr);
                                if (code) processVoucher(code, attachment.url, 'QR ');
                            })
                            .catch(() => {})
                    );
                }
            }
        }

        // Embeds
        if (message.embeds?.length > 0) {
            for (const embed of message.embeds) {
                const urls = [
                    embed.image?.url,
                    embed.thumbnail?.url
                ].filter(Boolean);
                
                for (const url of urls) {
                    imagePromises.push(
                        getImageFromURL(url)
                            .then(decodeQRFromImage)
                            .then(qr => {
                                const code = voucher.getVoucherCode(qr);
                                if (code) processVoucher(code, url, 'Embed QR ');
                            })
                            .catch(() => {})
                    );
                }
            }
        }

        // รอทุก promise พร้อมกัน (ไม่รอทีละตัว)
        if (imagePromises.length > 0) {
            await Promise.allSettled(imagePromises);
        }
    };

    client.connect(handleMessage);
}

// ===============================================
// 🏁 Start
// ===============================================

console.log(chalk.cyan("🚀 Starting..."));
console.log(chalk.yellow(`📱 ${phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2')}`));

keepAlive();

setTimeout(() => main(phone, userToken), 1000);

// Error Handling
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

process.on('SIGTERM', () => {
    sendWebhook([{
        title: "🔴 Bot หยุดทำงาน",
        color: 0xff0000,
        fields: [{ name: "📊 สถิติสุดท้าย", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }],
        timestamp: new Date().toISOString()
    }]);
    setTimeout(() => process.exit(0), 500);
});

process.on('SIGINT', () => {
    sendWebhook([{
        title: "🔴 Bot หยุดทำงาน",
        color: 0xff0000,
        fields: [{ name: "📊 สถิติสุดท้าย", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }],
        timestamp: new Date().toISOString()
    }]);
    setTimeout(() => process.exit(0), 500);
});
