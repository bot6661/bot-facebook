const chalk = require("chalk");
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");
const WebSocket = require('ws');

const keepAlive = require("./server.js");

console.clear();
process.env.TZ = "Asia/Bangkok";

console.log(chalk.cyan("\n===== TrueWallet Voucher Bot (Optimized) =====\n"));

// อ่าน token และ phone จาก Environment Variables
const phone = process.env.PHONE;
const userToken = process.env.DISCORD_TOKEN;

if (!userToken) {
    console.error(chalk.red("Error: DISCORD_TOKEN ไม่ถูกตั้งค่า!"));
    process.exit(1);
}

if (!phone) {
    console.error(chalk.red("Error: PHONE ไม่ถูกตั้งค่า!"));
    process.exit(1);
}

// ===============================================
// 🖼️ Image Processing Functions
// ===============================================

async function getImageFromURL(url) {
    try {
        const response = await axios.get(url, { 
            'responseType': "arraybuffer",
            timeout: 8000
        });
        return response.data;
    } catch (error) {
        throw error;
    }
}

async function decodeQRFromImage(imageBuffer) {
    try {
        const image = await jimp.read(imageBuffer);
        const qr = new qrcode();
        const result = await new Promise((resolve, reject) => {
            qr.callback = (err, value) => {
                if (err) reject(err);
                else resolve(value);
            };
            qr.decode(image.bitmap);
        });
        return result.result;
    } catch (error) {
        throw error;
    }
}

// ===============================================
// 💰 TrueWallet Voucher Class (Direct Redeem)
// ===============================================

class TrueWalletVoucher {
    constructor(phone) {
        this.phone = phone;
        this.baseUrl = 'https://gift.truemoney.com/campaign/vouchers';
        this.headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
    }

    getVoucherCode(text) {
        if (!text) return null;
        
        const patterns = [
            /v=([a-zA-Z0-9]+)/,
            /vouchers\/([a-zA-Z0-9]+)/,
            /campaign\/\?v=([a-zA-Z0-9]+)/,
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }
        return null;
    }

    // ⚡ REDEEM ตรงๆ ไม่ verify (เหมือน obfuscated code)
    async redeem(voucherCode) {
        const url = `${this.baseUrl}/${voucherCode}/redeem`;
        
        try {
            const response = await axios.post(
                url,
                {
                    mobile: this.phone,
                    voucher_hash: voucherCode
                },
                {
                    headers: this.headers,
                    timeout: 10000,
                    validateStatus: () => true // รับทุก status code
                }
            );

            const data = response.data;
            const statusCode = data?.status?.code;

            if (statusCode === 'SUCCESS') {
                return {
                    success: true,
                    amount: data.data?.voucher?.amount_baht || 0,
                    ownerName: data.data?.owner_profile?.full_name || 'Unknown',
                    message: data.status?.message || 'Success'
                };
            }

            return {
                success: false,
                message: data?.status?.message || 'Failed',
                code: statusCode
            };
            
        } catch (error) {
            return {
                success: false,
                message: error.response?.data?.status?.message || error.message,
                code: 'ERROR'
            };
        }
    }
}

// ===============================================
// 🤖 Discord User Client Class
// ===============================================

class DiscordUserClient {
    constructor(token) {
        this.token = token;
        this.gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';
        this.ws = null;
        this.heartbeatInterval = null;
        this.sessionId = null;
        this.sequence = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    connect(messageHandler) {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === 1) this.ws.close();
        }

        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
            console.log(chalk.green('✓ Connected to Discord'));
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
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
                case 11:
                    break;
            }
        });

        this.ws.on('close', (code) => {
            console.log(chalk.red(`❌ Disconnected: ${code}`));
            clearInterval(this.heartbeatInterval);
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = Math.min(5000 * this.reconnectAttempts, 30000);
                console.log(chalk.yellow(`🔄 Reconnecting in ${delay/1000}s...`));
                setTimeout(() => this.connect(messageHandler), delay);
            }
        });

        this.ws.on('error', (error) => {
            console.error(chalk.red('Error:'), error.message);
        });
    }

    startHeartbeat(interval) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
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
                    os: 'Linux',
                    browser: 'Chrome',
                    device: '',
                    system_locale: 'en-US',
                    browser_user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
                    browser_version: '120.0.0.0',
                    os_version: '',
                    referrer: '',
                    referring_domain: '',
                    referrer_current: '',
                    referring_domain_current: '',
                    release_channel: 'stable',
                    client_build_number: 261954,
                    client_event_source: null
                },
                presence: {
                    status: 'online',
                    since: 0,
                    activities: [],
                    afk: false
                },
                compress: false,
                client_state: {
                    guild_versions: {}
                }
            }
        });
    }

    handleDispatch(eventName, data, messageHandler) {
        switch (eventName) {
            case 'READY':
                console.log(chalk.green("\n===== LOGIN SUCCESS ====="));
                console.log(chalk.cyan(`👤 ${data.user.username}#${data.user.discriminator}`));
                console.log(chalk.cyan(`📱 ${phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2')}`));
                console.log(chalk.green("=========================\n"));
                this.sessionId = data.session_id;
                break;
            case 'MESSAGE_CREATE':
                messageHandler(data);
                break;
        }
    }

    send(payload) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    // ⚡ ส่งข้อความแค่ตอนจำเป็นเท่านั้น
    async sendMessage(channelId, content) {
        try {
            await axios.post(
                `https://discord.com/api/v10/channels/${channelId}/messages`,
                { content },
                {
                    headers: {
                        'Authorization': this.token,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
                    },
                    timeout: 5000
                }
            );
        } catch (error) {
            console.error(chalk.red('Send error:'), error.message);
        }
    }
}

// ===============================================
// 📊 Global Statistics
// ===============================================

let totalEarned = 0;
let successCount = 0;
let failCount = 0;

// ===============================================
// 🚀 Main Bot Function
// ===============================================

async function main(phone, userToken) {
    const voucher = new TrueWalletVoucher(phone);
    const client = new DiscordUserClient(userToken);
    const redeemedVouchers = new Set();

    const handleMessage = async (message) => {
        if (message.author?.bot) return;

        // ตรวจสอบ voucher code ในข้อความ
        if (message.content) {
            const voucherCode = voucher.getVoucherCode(message.content);
            if (voucherCode) {
                if (redeemedVouchers.has(voucherCode)) {
                    return; // ไม่แสดง log ซ้ำ
                }
                
                console.log(chalk.yellow(`🎫 ${voucherCode}`));
                
                // ⚡ REDEEM ตรงๆ ไม่ verify
                const result = await voucher.redeem(voucherCode);
                
                if (result.success) {
                    console.log(chalk.green(`✅ +${result.amount}฿ from ${result.ownerName}`));
                    redeemedVouchers.add(voucherCode);
                    totalEarned += result.amount;
                    successCount++;
                    
                    // ส่งข้อความแค่ตอนสำเร็จ
                    await client.sendMessage(
                        message.channel_id, 
                        `✅ รับ ${result.amount}฿ จาก ${result.ownerName}`
                    );
                } else {
                    console.log(chalk.red(`❌ ${result.message}`));
                    failCount++;
                }
            }
        }

        // ตรวจสอบรูปภาพ
        if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
                if (attachment.content_type?.startsWith('image/')) {
                    try {
                        const imageData = await getImageFromURL(attachment.url);
                        const decodedQR = await decodeQRFromImage(imageData);
                        const voucherCode = voucher.getVoucherCode(decodedQR);

                        if (voucherCode && !redeemedVouchers.has(voucherCode)) {
                            console.log(chalk.yellow(`🎫 ${voucherCode} (from image)`));
                            
                            const result = await voucher.redeem(voucherCode);
                            
                            if (result.success) {
                                console.log(chalk.green(`✅ +${result.amount}฿ from ${result.ownerName}`));
                                redeemedVouchers.add(voucherCode);
                                totalEarned += result.amount;
                                successCount++;
                                
                                await client.sendMessage(
                                    message.channel_id, 
                                    `✅ รับ ${result.amount}฿ จาก ${result.ownerName}`
                                );
                            } else {
                                console.log(chalk.red(`❌ ${result.message}`));
                                failCount++;
                            }
                        }
                    } catch (error) {
                        console.error(chalk.red('QR error:'), error.message);
                    }
                }
            }
        }

        // คำสั่ง
        if (message.content === "!ping") {
            await client.sendMessage(message.channel_id, "🏓 Pong!");
        }

        if (message.content === "!stats") {
            const uptime = Math.floor(process.uptime());
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            await client.sendMessage(
                message.channel_id, 
                `📊 Stats\n✅ ${successCount} | ❌ ${failCount}\n💰 ${totalEarned}฿\n⏱️ ${hours}h ${minutes}m`
            );
        }
    };

    client.connect(handleMessage);
}

// ===============================================
// 🏁 Start
// ===============================================

console.log(chalk.cyan("Starting bot..."));
console.log(chalk.yellow("📱"), phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2'));

keepAlive();

setTimeout(() => {
    main(phone, userToken);
}, 2000);

// Error Handling
process.on("uncaughtException", (error) => {
    console.log(chalk.red("Error:"), error.message);
});

process.on("unhandledRejection", (error) => {
    console.log(chalk.red("Error:"), error.message);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('Shutting down...'));
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log(chalk.yellow('Shutting down...'));
    process.exit(0);
});
