const chalk = require("chalk");
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");
const keepAlive = require("./server.js");

console.clear();
process.env.TZ = "Asia/Bangkok";

console.log(chalk.cyan("\n" + "=".repeat(60)));
console.log(chalk.cyan("   Discord TrueWallet Voucher Bot"));
console.log(chalk.cyan("   with Built-in Proxy Server"));
console.log(chalk.cyan("=".repeat(60) + "\n"));

// Environment Variables
const phone = process.env.PHONE || "0959426013";
const userToken = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

// 🔥 Proxy URL (ใช้ภายใน)
const PROXY_URL = `http://localhost:${PORT}`;

// ตรวจสอบ Token
if (!userToken) {
    console.error(chalk.red("❌ Error: DISCORD_TOKEN ไม่ถูกตั้งค่า!"));
    console.log(chalk.yellow("📝 ตั้งค่าใน Render Dashboard → Environment"));
    process.exit(1);
}

console.log(chalk.green("✅ Configuration OK"));
console.log(chalk.gray(`📱 Phone: ${phone}`));
console.log(chalk.gray(`🌐 Proxy: ${PROXY_URL}\n`));

// ============================================
// 🖼️ ฟังก์ชันดึงรูปภาพ
// ============================================
async function getImageFromURL(url) {
    try {
        const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 5000
        });
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch image: ${error.message}`);
    }
}

// ============================================
// 📷 ฟังก์ชันอ่าน QR Code
// ============================================
async function decodeQRFromImage(imageBuffer) {
    try {
        const image = await jimp.read(imageBuffer);
        const qr = new qrcode();
        
        return new Promise((resolve, reject) => {
            qr.callback = (err, value) => {
                if (err) reject(err);
                else resolve(value.result);
            };
            qr.decode(image.bitmap);
        });
    } catch (error) {
        throw new Error(`Failed to decode QR: ${error.message}`);
    }
}

// ============================================
// 🎫 Class จัดการ Voucher
// ============================================
class Voucher {
    constructor(phone, proxyUrl) { 
        this.phone = phone;
        this.proxyUrl = proxyUrl;
    }
    
    getQrCode(text) {
        if (!text) return null;
        const match = text.match(/v=([a-zA-Z0-9]+)/);
        return match ? match[1] : null;
    }
    
    async redeem(voucherCode) {
        const url = `${this.proxyUrl}/topup/angpaofree/before/${voucherCode}/${this.phone}`;
        const startTime = Date.now();
        
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                validateStatus: () => true
            });
            
            const duration = Date.now() - startTime;
            const data = response.data;
            
            // Cloudflare block
            if (data?.status?.message === "CLOUDFLARE_BLOCK") {
                return {
                    error: true,
                    message: "ถูก Cloudflare บล็อก",
                    duration
                };
            }
            
            // Success
            if (data?.status?.message === "SUCCESS" || data?.status?.code === "SUCCESS") {
                return { 
                    error: false, 
                    amount: data.data?.amount_baht || data.data?.my_ticket?.amount_baht || 0,
                    owner: data.data?.owner_profile?.full_name || "ไม่ทราบชื่อ",
                    duration
                };
            }
            
            // Failed
            return { 
                error: true, 
                message: data?.status?.message || "ไม่สำเร็จ",
                duration
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            
            return { 
                error: true, 
                message: error.message,
                duration
            };
        }
    }
}

// ============================================
// 💬 Class จัดการ Discord Client
// ============================================
class DiscordUserClient {
    constructor(token) {
        this.token = token;
        this.gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';
        this.ws = null;
        this.heartbeatInterval = null;
        this.sequence = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    connect(messageHandler) {
        const WebSocket = require('ws');
        
        console.log(chalk.yellow('🔄 กำลังเชื่อมต่อ Discord...'));
        
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
            console.log(chalk.green('✅ เชื่อมต่อ Discord สำเร็จ'));
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                const { op, d, s, t } = payload;
                
                if (s) this.sequence = s;

                switch (op) {
                    case 10:
                        this.startHeartbeat(d.heartbeat_interval);
                        this.identify();
                        break;
                    case 0:
                        this.handleDispatch(t, d, messageHandler);
                        break;
                    case 9:
                        this.reconnect(messageHandler);
                        break;
                }
            } catch (error) {
                console.error(chalk.red('Error:'), error.message);
            }
        });

        this.ws.on('close', (code) => {
            console.log(chalk.red(`❌ ตัดการเชื่อมต่อ (${code})`));
            clearInterval(this.heartbeatInterval);
            this.reconnect(messageHandler);
        });

        this.ws.on('error', (error) => {
            console.error(chalk.red('💥 WebSocket Error:'), error.message);
        });
    }

    reconnect(messageHandler) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(chalk.red('❌ ไม่สามารถเชื่อมต่อได้'));
            process.exit(1);
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        
        console.log(chalk.yellow(`⏳ รอ ${delay/1000} วินาที...`));
        
        setTimeout(() => this.connect(messageHandler), delay);
    }

    startHeartbeat(interval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === 1) {
                this.send({ op: 1, d: this.sequence });
            }
        }, interval);
    }

    identify() {
        this.send({
            op: 2,
            d: {
                token: this.token,
                capabilities: 16381,
                properties: {
                    os: 'Windows',
                    browser: 'Chrome',
                    device: '',
                    browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                presence: { status: 'online', activities: [], afk: false }
            }
        });
    }

    handleDispatch(eventName, data, messageHandler) {
        switch (eventName) {
            case 'READY':
                console.log(chalk.green("\n" + "=".repeat(60)));
                console.log(chalk.green("       ✅ LOGIN SUCCESS"));
                console.log(chalk.green("=".repeat(60)));
                console.log(chalk.cyan(`👤 ${data.user.username}#${data.user.discriminator}`));
                console.log(chalk.cyan(`🆔 ${data.user.id}`));
                console.log(chalk.green("=".repeat(60)));
                console.log(chalk.green("       🤖 Bot พร้อมทำงาน"));
                console.log(chalk.green("=".repeat(60) + "\n"));
                break;
            case 'MESSAGE_CREATE':
                messageHandler(data);
                break;
        }
    }

    send(payload) {
        if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify(payload));
        }
    }
}

// ============================================
// 📊 Statistics
// ============================================
const stats = {
    total: 0,
    success: 0,
    fail: 0,
    amount: 0
};

// ============================================
// 🚀 Main Function
// ============================================
async function main(phone, userToken, proxyUrl) {
    const voucher = new Voucher(phone, proxyUrl);
    const client = new DiscordUserClient(userToken);
    const redeemedVouchers = new Set();

    const handleMessage = async (message) => {
        try {
            if (message.author?.bot) return;

            // ============================================
            // 📝 ตรวจสอบข้อความ
            // ============================================
            if (message.content) {
                const qrCode = voucher.getQrCode(message.content);
                
                if (qrCode && !redeemedVouchers.has(qrCode)) {
                    stats.total++;
                    
                    console.log(chalk.yellow("\n" + "=".repeat(60)));
                    console.log(chalk.yellow(`🎫 Voucher: ${qrCode}`));
                    console.log(chalk.cyan("⚡ กำลัง Redeem..."));
                    
                    const result = await voucher.redeem(qrCode);
                    
                    if (result.error) {
                        stats.fail++;
                        console.log(chalk.red(`❌ ${result.message} (${result.duration}ms)`));
                    } else {
                        stats.success++;
                        stats.amount += result.amount;
                        redeemedVouchers.add(qrCode);
                        
                        console.log(chalk.green(`✅ +${result.amount}฿ จาก ${result.owner}`));
                        console.log(chalk.cyan(`⚡ ${result.duration}ms`));
                        console.log(chalk.magenta(`💎 รวม: ${stats.amount}฿`));
                    }
                    
                    console.log(chalk.gray(`📊 ${stats.success}✅ / ${stats.fail}❌`));
                    console.log(chalk.yellow("=".repeat(60) + "\n"));
                }
            }

            // ============================================
            // 🖼️ ตรวจสอบรูปภาพ
            // ============================================
            if (message.attachments?.length > 0) {
                for (const att of message.attachments) {
                    if (att.content_type?.startsWith('image/')) {
                        console.log(chalk.blue("🖼️ กำลังอ่าน QR..."));
                        
                        try {
                            const imageData = await getImageFromURL(att.url);
                            const decodedQR = await decodeQRFromImage(imageData);
                            const qrCode = voucher.getQrCode(decodedQR);
                            
                            if (qrCode && !redeemedVouchers.has(qrCode)) {
                                stats.total++;
                                
                                console.log(chalk.yellow("\n" + "=".repeat(60)));
                                console.log(chalk.yellow(`🎫 Voucher (รูป): ${qrCode}`));
                                console.log(chalk.cyan("⚡ กำลัง Redeem..."));
                                
                                const result = await voucher.redeem(qrCode);
                                
                                if (result.error) {
                                    stats.fail++;
                                    console.log(chalk.red(`❌ ${result.message} (${result.duration}ms)`));
                                } else {
                                    stats.success++;
                                    stats.amount += result.amount;
                                    redeemedVouchers.add(qrCode);
                                    
                                    console.log(chalk.green(`✅ +${result.amount}฿ จาก ${result.owner}`));
                                    console.log(chalk.cyan(`⚡ ${result.duration}ms`));
                                    console.log(chalk.magenta(`💎 รวม: ${stats.amount}฿`));
                                }
                                
                                console.log(chalk.gray(`📊 ${stats.success}✅ / ${stats.fail}❌`));
                                console.log(chalk.yellow("=".repeat(60) + "\n"));
                            }
                        } catch (error) {
                            console.error(chalk.red("❌ อ่าน QR ไม่ได้:"), error.message);
                        }
                    }
                }
            }

            // ============================================
            // 🎯 คำสั่งพิเศษ
            // ============================================
            if (message.content === "!stats") {
                console.log(chalk.cyan("\n" + "=".repeat(60)));
                console.log(chalk.cyan("📊 สถิติการทำงาน"));
                console.log(chalk.cyan("=".repeat(60)));
                console.log(chalk.gray(`Total Vouchers: ${stats.total}`));
                console.log(chalk.green(`✅ Success: ${stats.success}`));
                console.log(chalk.red(`❌ Failed: ${stats.fail}`));
                console.log(chalk.magenta(`💰 Total Amount: ${stats.amount}฿`));
                console.log(chalk.cyan("=".repeat(60) + "\n"));
            }
            
        } catch (error) {
            console.error(chalk.red("❌ Error:"), error.message);
        }
    };

    client.connect(handleMessage);
}

// ============================================
// 🚀 Start Everything
// ============================================

// 1. เริ่ม Server + Proxy
keepAlive();

// 2. รอ 3 วินาที ให้ Server เริ่มก่อน
setTimeout(() => {
    console.log(chalk.cyan("🚀 กำลังเริ่ม Bot...\n"));
    main(phone, userToken, PROXY_URL);
}, 3000);

// ============================================
// 🛡️ Error Handlers
// ============================================
process.on("uncaughtException", (error) => {
    console.log(chalk.red("\n💥 Uncaught Exception:"), error.message);
});

process.on("unhandledRejection", (error) => {
    console.log(chalk.red("\n💥 Unhandled Rejection:"), error.message);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('\n📴 Shutting down gracefully...'));
    console.log(chalk.cyan("\n" + "=".repeat(60)));
    console.log(chalk.cyan("📊 Final Statistics"));
    console.log(chalk.cyan("=".repeat(60)));
    console.log(chalk.gray(`Total Vouchers: ${stats.total}`));
    console.log(chalk.green(`✅ Success: ${stats.success}`));
    console.log(chalk.red(`❌ Failed: ${stats.fail}`));
    console.log(chalk.magenta(`💰 Total Amount: ${stats.amount}฿`));
    console.log(chalk.cyan("=".repeat(60) + "\n"));
    process.exit(0);
});
