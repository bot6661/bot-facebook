const chalk = require("chalk");
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");
const WebSocket = require('ws');

const keepAlive = require("./server.js");

console.clear();
process.env.TZ = "Asia/Bangkok";

console.log(chalk.cyan("\n===== TrueWallet Voucher Bot (Anti-Block) =====\n"));

// อ่าน token และ phone จาก Environment Variables
const phone = process.env.PHONE;
const userToken = process.env.DISCORD_TOKEN;
const SEND_FAIL_MESSAGE = process.env.SEND_FAIL_MESSAGE === 'true';
const LOG_USER_ID = "1236863190785196106"; // ไอดี @wexcea

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
// 💬 ฟังก์ชันส่ง DM
// ===============================================

async function sendDM(client, userId, content) {
    try {
        // สร้าง DM Channel
        const dmResponse = await axios.post(
            'https://discord.com/api/v10/users/@me/channels',
            { recipient_id: userId },
            {
                headers: {
                    'Authorization': client.token,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
                },
                timeout: 5000
            }
        );
        
        const dmChannelId = dmResponse.data.id;
        
        // ส่งข้อความใน DM
        await axios.post(
            `https://discord.com/api/v10/channels/${dmChannelId}/messages`,
            { content },
            {
                headers: {
                    'Authorization': client.token,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
                },
                timeout: 5000
            }
        );
    } catch (error) {
        console.error(chalk.red('DM send error:'), error.message);
    }
}

// ===============================================
// 💰 TrueWallet Voucher Class (Proxy + Direct)
// ===============================================

class TrueWalletVoucher {
    constructor(phone) {
        this.phone = phone;
        
        // ⚙️ ตั้งค่าตรงนี้เลย
        this.USE_PROXY = true; // true = ใช้ Proxy (แนะนำ), false = Direct
        this.PROXY_URL = 'https://truewalletproxy-755211536068837409.rcf2.deploys.app/api';
        
        // Direct API
        this.directUrl = 'https://gift.truemoney.com/campaign/vouchers';
        this.headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

    // ⚡ REDEEM ผ่าน PROXY (ไม่โดนบล็อก)
    async redeemViaProxy(voucherCode) {
        try {
            const response = await axios.post(
                this.PROXY_URL,
                {
                    mobile: this.phone,
                    voucher: voucherCode
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'multilabxxxxxxxx'
                    },
                    timeout: 10000,
                    validateStatus: () => true
                }
            );

            const data = response.data;
            const statusCode = data?.status?.code;

            if (statusCode === 'SUCCESS') {
                return {
                    success: true,
                    amount: Number(data.data.my_ticket.amount_baht.replace(/,/g, "")),
                    ownerName: data.data.owner_profile.full_name || 'Unknown',
                    message: data.status?.message || 'Success',
                    method: 'proxy'
                };
            }

            return {
                success: false,
                message: data?.status?.message || data?.status?.code || 'Failed',
                code: statusCode,
                method: 'proxy'
            };
            
        } catch (error) {
            return {
                success: false,
                message: error.response?.data?.status?.message || error.message,
                code: 'ERROR',
                method: 'proxy'
            };
        }
    }

    // ⚡ REDEEM แบบตรง (อาจโดนบล็อก)
    async redeemDirect(voucherCode) {
        const url = `${this.directUrl}/${voucherCode}/redeem`;
        
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
                    validateStatus: () => true
                }
            );

            const data = response.data;
            const statusCode = data?.status?.code;

            if (statusCode === 'SUCCESS') {
                return {
                    success: true,
                    amount: data.data?.voucher?.amount_baht || 0,
                    ownerName: data.data?.owner_profile?.full_name || 'Unknown',
                    message: data.status?.message || 'Success',
                    method: 'direct'
                };
            }

            return {
                success: false,
                message: data?.status?.message || 'Failed',
                code: statusCode,
                method: 'direct'
            };
            
        } catch (error) {
            return {
                success: false,
                message: error.response?.data?.status?.message || error.message,
                code: 'ERROR',
                method: 'direct'
            };
        }
    }

    // ⚡ REDEEM (เลือกอัตโนมัติ)
    async redeem(voucherCode) {
        if (this.USE_PROXY) {
            return await this.redeemViaProxy(voucherCode);
        } else {
            return await this.redeemDirect(voucherCode);
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
        this.lastHeartbeatAck = true;
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
            try {
                const payload = JSON.parse(data);
                const { op, d, s, t } = payload;
                if (s) this.sequence = s;

                switch (op) {
                    case 10: // Hello
                        this.startHeartbeat(d.heartbeat_interval);
                        if (this.sessionId && this.sequence) {
                            this.resume();
                        } else {
                            this.identify();
                        }
                        break;
                    case 0: // Dispatch
                        this.handleDispatch(t, d, messageHandler);
                        break;
                    case 11: // Heartbeat ACK
                        this.lastHeartbeatAck = true;
                        break;
                    case 9: // Invalid Session
                        console.log(chalk.yellow('⚠️ Invalid session, reidentifying...'));
                        this.sessionId = null;
                        this.sequence = null;
                        setTimeout(() => this.identify(), 2000);
                        break;
                    case 7: // Reconnect
                        console.log(chalk.yellow('🔄 Discord requested reconnect'));
                        this.ws.close();
                        break;
                }
            } catch (error) {
                console.error(chalk.red('Parse error:'), error.message);
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(chalk.red(`❌ Disconnected: ${code} - ${reason || 'No reason'}`));
            clearInterval(this.heartbeatInterval);
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = Math.min(5000 * this.reconnectAttempts, 30000);
                console.log(chalk.yellow(`🔄 Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`));
                setTimeout(() => this.connect(messageHandler), delay);
            } else {
                console.error(chalk.red('❌ Max reconnect attempts reached'));
            }
        });

        this.ws.on('error', (error) => {
            console.error(chalk.red('WS Error:'), error.message);
        });
    }

    startHeartbeat(interval) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                if (!this.lastHeartbeatAck) {
                    console.log(chalk.yellow('⚠️ Heartbeat not acknowledged, reconnecting...'));
                    this.ws.close(4000, 'Heartbeat timeout');
                    return;
                }
                this.lastHeartbeatAck = false;
                this.send({ op: 1, d: this.sequence });
            }
        }, interval);
    }

    identify() {
        const delay = Math.floor(Math.random() * 3000) + 1000; // 1-4 วินาที
        setTimeout(() => {
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
                        browser_user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
        }, delay);
    }

    resume() {
        console.log(chalk.blue('🔄 Resuming session...'));
        this.send({
            op: 6,
            d: {
                token: this.token,
                session_id: this.sessionId,
                seq: this.sequence
            }
        });
    }

    handleDispatch(eventName, data, messageHandler) {
        switch (eventName) {
            case 'READY':
                console.log(chalk.green("\n===== LOGIN SUCCESS ====="));
                console.log(chalk.cyan(`👤 ${data.user.username}#${data.user.discriminator}`));
                console.log(chalk.cyan(`🆔 ${data.user.id}`));
                console.log(chalk.cyan(`📱 ${phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2')}`));
                console.log(chalk.green("=========================\n"));
                this.sessionId = data.session_id;
                break;
            case 'RESUMED':
                console.log(chalk.green('✅ Session resumed successfully'));
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
}

// ===============================================
// 📊 Global Statistics
// ===============================================

let totalEarned = 0;
let successCount = 0;
let failCount = 0;
const startTime = Date.now();

// ===============================================
// 🚀 Main Bot Function
// ===============================================

async function main(phone, userToken) {
    const voucher = new TrueWalletVoucher(phone);
    const client = new DiscordUserClient(userToken);
    const redeemedVouchers = new Set();

    // แสดงว่าใช้ method ไหน
    console.log(chalk.magenta(`🔧 Redeem Method: ${voucher.USE_PROXY ? 'PROXY (Anti-Block)' : 'DIRECT'}`));
    if (voucher.USE_PROXY) {
        console.log(chalk.magenta(`🌐 Proxy URL: ${voucher.PROXY_URL}`));
    }
    console.log(chalk.gray("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

    const handleMessage = async (message) => {
        try {
            if (message.author?.bot) return;

            // ตรวจสอบ voucher code ในข้อความ
            if (message.content) {
                const voucherCode = voucher.getVoucherCode(message.content);
                if (voucherCode) {
                    if (redeemedVouchers.has(voucherCode)) {
                        return; // ไม่แสดง log ซ้ำ
                    }
                    
                    console.log(chalk.yellow(`\n🎫 Voucher: ${voucherCode}`));
                    
                    // ⚡ REDEEM
                    const result = await voucher.redeem(voucherCode);
                    
                    if (result.success) {
                        console.log(chalk.green(`✅ +${result.amount}฿ from ${result.ownerName} [${result.method}]`));
                        redeemedVouchers.add(voucherCode);
                        totalEarned += result.amount;
                        successCount++;
                        
                        // ส่งข้อความตอนสำเร็จไปที่ DM
                        await sendDM(
                            client, 
                            LOG_USER_ID,
                            `✅ รับ ${result.amount}฿ จาก ${result.ownerName}\n📍 Channel: <#${message.channel_id}>`
                        );
                    } else {
                        console.log(chalk.red(`❌ ${result.message} [${result.method}]`));
                        failCount++;
                    }
                    
                    console.log(chalk.gray(`📊 Success: ${successCount} | Fail: ${failCount} | Total: ${totalEarned}฿`));
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
                                console.log(chalk.yellow(`\n🎫 Voucher (image): ${voucherCode}`));
                                
                                const result = await voucher.redeem(voucherCode);
                                
                                if (result.success) {
                                    console.log(chalk.green(`✅ +${result.amount}฿ from ${result.ownerName} [${result.method}]`));
                                    redeemedVouchers.add(voucherCode);
                                    totalEarned += result.amount;
                                    successCount++;
                                    
                                    await sendDM(
                                        client,
                                        LOG_USER_ID,
                                        `✅ รับ ${result.amount}฿ จาก ${result.ownerName}\n📍 Channel: <#${message.channel_id}>\n🖼️ From QR Code`
                                    );
                                } else {
                                    console.log(chalk.red(`❌ ${result.message} [${result.method}]`));
                                    failCount++;
                                }
                                
                                console.log(chalk.gray(`📊 Success: ${successCount} | Fail: ${failCount} | Total: ${totalEarned}฿`));
                            }
                        } catch (error) {
                            console.error(chalk.red('QR decode error:'), error.message);
                        }
                    }
                }
            }

            // คำสั่ง - ส่งไปที่ DM ทั้งหมด
            if (message.content === "!ping") {
                await sendDM(client, LOG_USER_ID, "🏓 Pong! Bot is online");
            }

            if (message.content === "!stats") {
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const successRate = successCount + failCount > 0 
                    ? ((successCount / (successCount + failCount)) * 100).toFixed(1)
                    : 0;
                
                const stats = `📊 **Bot Statistics**
✅ Success: ${successCount}
❌ Failed: ${failCount}
📈 Success Rate: ${successRate}%
💰 Total Earned: ${totalEarned}฿
⏱️ Uptime: ${hours}h ${minutes}m
🔢 Processed: ${redeemedVouchers.size} unique vouchers
🔧 Method: ${voucher.USE_PROXY ? 'Proxy' : 'Direct'}`;
                
                await sendDM(client, LOG_USER_ID, stats);
            }

            if (message.content === "!help") {
                const help = `🤖 **Available Commands**
\`!ping\` - Check bot status
\`!stats\` - View statistics
\`!help\` - Show this help

**How to use:**
Send voucher link or QR code image
Bot will automatically redeem it!`;
                
                await sendDM(client, LOG_USER_ID, help);
            }

        } catch (error) {
            console.error(chalk.red('Handler error:'), error.message);
        }
    };

    client.connect(handleMessage);
}

// ===============================================
// 🏁 Start Bot
// ===============================================

console.log(chalk.cyan("🚀 Starting bot..."));
console.log(chalk.yellow("📱 Phone:"), phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2'));
console.log(chalk.yellow("⚙️ Send fail messages:"), SEND_FAIL_MESSAGE ? 'Yes' : 'No (logs only)');

keepAlive();

setTimeout(() => {
    main(phone, userToken);
}, 2000);

// Error Handling
process.on("uncaughtException", (error) => {
    console.log(chalk.red("💥 Uncaught Exception:"), error.message);
});

process.on("unhandledRejection", (error) => {
    console.log(chalk.red("💥 Unhandled Rejection:"), error.message);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('\n📴 Shutting down gracefully...'));
    console.log(chalk.cyan(`📊 Final Stats: ✅ ${successCount} | ❌ ${failCount} | 💰 ${totalEarned}฿`));
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log(chalk.yellow('\n📴 Shutting down gracefully...'));
    console.log(chalk.cyan(`📊 Final Stats: ✅ ${successCount} | ❌ ${failCount} | 💰 ${totalEarned}฿`));
    process.exit(0);
});

// Heartbeat log (ทุก 5 นาที)
setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000 / 60);
    console.log(chalk.gray(`⏰ [${new Date().toLocaleTimeString('th-TH')}] Alive | Uptime: ${uptime}m | ✅ ${successCount} | ❌ ${failCount} | 💰 ${totalEarned}฿`));
}, 300000);
