const chalk = require("chalk");
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");
const WebSocket = require('ws');

const keepAlive = require("./server.js");

console.clear();
process.env.TZ = "Asia/Bangkok";

console.log(chalk.cyan("\n===== TrueWallet Voucher Bot (Official API) =====\n"));

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
            timeout: 10000
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
// 💰 TrueWallet Voucher Class (Official API)
// ===============================================

class TrueWalletVoucher {
    constructor(phone) {
        this.phone = phone;
        this.baseUrl = 'https://gift.truemoney.com/campaign/vouchers';
        this.headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
    }

    // แยก Voucher Code จาก URL หรือข้อความ
    getVoucherCode(text) {
        if (!text) return null;
        
        // รองรับหลายรูปแบบ
        const patterns = [
            /v=([a-zA-Z0-9]+)/,                          // ?v=CODE
            /vouchers\/([a-zA-Z0-9]+)/,                  // /vouchers/CODE
            /campaign\/\?v=([a-zA-Z0-9]+)/,              // /campaign/?v=CODE
            /gift\.truemoney\.com.*?([a-zA-Z0-9]{16,})/  // fallback
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }

        return null;
    }

    // ขั้นตอนที่ 1: Verify ซอง (ตรวจสอบว่ายังใช้ได้ไหม)
    async verify(voucherCode) {
        const url = `${this.baseUrl}/${voucherCode}/verify?mobile=${this.phone}`;
        try {
            const response = await axios.get(url, {
                headers: this.headers,
                timeout: 15000
            });

            return {
                success: true,
                data: response.data,
                message: "Verify สำเร็จ"
            };
        } catch (error) {
            const errorMsg = error.response?.data?.status?.message || error.message;
            return {
                success: false,
                data: error.response?.data || null,
                message: errorMsg
            };
        }
    }

    // ขั้นตอนที่ 2: Redeem ซอง (รับเงินจริง)
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
                    timeout: 15000
                }
            );

            // ตรวจสอบ response จาก TrueWallet
            const statusCode = response.data?.status?.code;
            const isSuccess = statusCode === 'SUCCESS';

            return {
                success: isSuccess,
                data: response.data,
                amount: response.data?.data?.voucher?.amount_baht || 0,
                ownerName: response.data?.data?.owner_profile?.full_name || 'Unknown',
                message: response.data?.status?.message || 'Unknown'
            };
        } catch (error) {
            const errorMsg = error.response?.data?.status?.message || error.message;
            return {
                success: false,
                data: error.response?.data || null,
                amount: 0,
                ownerName: 'Unknown',
                message: errorMsg
            };
        }
    }

    // ฟังก์ชันหลัก: Verify แล้วค่อย Redeem
    async processVoucher(voucherCode) {
        console.log(chalk.blue("📋 Step 1: กำลังตรวจสอบซอง..."));

        // Step 1: Verify
        const verifyResult = await this.verify(voucherCode);

        if (!verifyResult.success) {
            return {
                success: false,
                step: 'verify',
                message: `Verify ล้มเหลว: ${verifyResult.message}`
            };
        }

        console.log(chalk.green("✓ ซองใช้งานได้"));

        // รอ 1 วินาทีก่อน redeem (ป้องกัน rate limit)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Step 2: Redeem
        console.log(chalk.blue("💰 Step 2: กำลัง redeem..."));
        const redeemResult = await this.redeem(voucherCode);

        if (redeemResult.success) {
            return {
                success: true,
                step: 'redeem',
                amount: redeemResult.amount,
                ownerName: redeemResult.ownerName,
                message: `รับเงินสำเร็จ ${redeemResult.amount}฿ จาก ${redeemResult.ownerName}`
            };
        } else {
            return {
                success: false,
                step: 'redeem',
                message: `Redeem ล้มเหลว: ${redeemResult.message}`
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
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
            console.log(chalk.green('✓ เชื่อมต่อ Discord Gateway สำเร็จ'));
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
            const payload = JSON.parse(data);
            const { op, d, s, t } = payload;
            if (s) this.sequence = s;

            switch (op) {
                case 10: // Hello
                    this.startHeartbeat(d.heartbeat_interval);
                    this.identify();
                    break;
                case 0: // Dispatch
                    this.handleDispatch(t, d, messageHandler);
                    break;
                case 11: // Heartbeat ACK
                    // Silent acknowledgment
                    break;
                case 7: // Reconnect
                    console.log(chalk.yellow('🔄 Discord ขอให้ reconnect'));
                    this.ws.close();
                    break;
                case 9: // Invalid Session
                    console.log(chalk.red('❌ Invalid session, reconnecting...'));
                    setTimeout(() => this.connect(messageHandler), 5000);
                    break;
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(chalk.red(`❌ Discord ตัดการเชื่อมต่อ: ${code} - ${reason}`));
            clearInterval(this.heartbeatInterval);
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = Math.min(5000 * this.reconnectAttempts, 30000);
                console.log(chalk.yellow(`🔄 พยายามเชื่อมต่อครั้งที่ ${this.reconnectAttempts} ใน ${delay/1000} วินาที...`));
                setTimeout(() => this.connect(messageHandler), delay);
            } else {
                console.log(chalk.red('❌ เชื่อมต่อไม่สำเร็จหลังพยายาม 10 ครั้ง'));
                console.log(chalk.yellow('กำลังรีเซ็ตและพยายามใหม่...'));
                this.reconnectAttempts = 0;
                setTimeout(() => this.connect(messageHandler), 60000); // รอ 1 นาทีแล้วลองใหม่
            }
        });

        this.ws.on('error', (error) => {
            console.error(chalk.red('💥 Discord WebSocket Error:'), error.message);
        });
    }

    startHeartbeat(interval) {
        clearInterval(this.heartbeatInterval); // Clear existing interval
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
                    system_locale: 'th-TH',
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
    }

    handleDispatch(eventName, data, messageHandler) {
        switch (eventName) {
            case 'READY':
                console.log(chalk.green("\n===== LOGIN SUCCESS ====="));
                console.log(chalk.cyan(`👤 User: ${data.user.username}#${data.user.discriminator}`));
                console.log(chalk.cyan(`🆔 ID: ${data.user.id}`));
                console.log(chalk.cyan(`📱 Phone: ${phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2')}`));
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
                    }
                }
            );
            console.log(chalk.green("📨 ส่งข้อความสำเร็จ"));
        } catch (error) {
            console.error(chalk.red('❌ Error sending message:'), error.response?.data || error.message);
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
        // ข้าม message จาก bot
        if (message.author?.bot) return;

        // ตรวจสอบ voucher code ในข้อความ
        if (message.content) {
            const voucherCode = voucher.getVoucherCode(message.content);
            if (voucherCode) {
                await processVoucher(voucherCode);
            }
        }

        // ตรวจสอบรูปภาพที่แนบมา
        if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
                if (attachment.content_type?.startsWith('image/')) {
                    console.log(chalk.blue("🖼️ พบรูปภาพ กำลังอ่าน QR Code..."));
                    try {
                        const imageData = await getImageFromURL(attachment.url);
                        const decodedQR = await decodeQRFromImage(imageData);
                        const voucherCode = voucher.getVoucherCode(decodedQR);

                        if (voucherCode) {
                            await processVoucher(voucherCode);
                        } else {
                            console.log(chalk.gray("⚠️ ไม่พบ voucher code ในรูปภาพ"));
                        }
                    } catch (error) {
                        console.error(chalk.red("❌ Error reading QR Code:"), error.message);
                    }
                }
            }
        }

        // คำสั่งพิเศษ
        if (message.content === "!ping") {
            await client.sendMessage(message.channel_id, "🏓 Pong! Bot ทำงานปกติ");
        }

        if (message.content === "!stats") {
            const uptime = Math.floor(process.uptime());
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const stats = `📊 **สถิติการทำงาน**
✅ สำเร็จ: ${successCount} ครั้ง
❌ ล้มเหลว: ${failCount} ครั้ง
💰 รวมได้: ${totalEarned}฿
⏱️ ทำงานมาแล้ว: ${hours}h ${minutes}m`;
            await client.sendMessage(message.channel_id, stats);
        }

        if (message.content === "!help") {
            const help = `🤖 **คำสั่งที่ใช้ได้:**
\`!ping\` - ตรวจสอบสถานะ
\`!stats\` - ดูสถิติ
\`!help\` - แสดงคำสั่งทั้งหมด

**วิธีใช้:**
ส่งลิงก์ซองหรือรูป QR Code มาในแชท
บอทจะรับซองให้อัตโนมัติ!`;
            await client.sendMessage(message.channel_id, help);
        }
    };

    // ฟังก์ชันประมวลผล Voucher
    async function processVoucher(voucherCode) {
        // ตรวจสอบว่าเคย redeem แล้วหรือยัง
        if (redeemedVouchers.has(voucherCode)) {
            console.log(chalk.gray(`⏭️ ข้าม voucher ซ้ำ: ${voucherCode}`));
            return;
        }

        console.log(chalk.yellow("\n🎫 ============= NEW VOUCHER ============="));
        console.log(chalk.yellow(`🔖 Code: ${voucherCode}`));
        console.log(chalk.gray(`⏰ Time: ${new Date().toLocaleString('th-TH')}`));

        const result = await voucher.processVoucher(voucherCode);

        if (result.success) {
            console.log(chalk.green(`✅ ${result.message}`));
            redeemedVouchers.add(voucherCode);
            totalEarned += result.amount;
            successCount++;
            console.log(chalk.magenta(`📈 สถิติ: ✅ ${successCount} | ❌ ${failCount} | 💰 ${totalEarned}฿`));
        } else {
            console.log(chalk.red(`❌ ${result.message}`));
            failCount++;
            console.log(chalk.magenta(`📈 สถิติ: ✅ ${successCount} | ❌ ${failCount} | 💰 ${totalEarned}฿`));
        }

        console.log(chalk.yellow("==========================================\n"));
    }

    client.connect(handleMessage);
}

// ===============================================
// 🏁 Start Bot
// ===============================================

console.log(chalk.cyan("===== เริ่มต้น TrueWallet Voucher Bot =====\n"));
console.log(chalk.yellow("📱 เบอร์รับเงิน:"), phone ? phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2') : 'ไม่ได้ตั้งค่า');
console.log(chalk.yellow("🔐 กำลัง login เข้า Discord...\n"));

main(phone, userToken);

// เรียก server.js เพื่อ keep-alive
keepAlive();

// Error Handling
process.on("uncaughtException", (error) => {
    console.log(chalk.red("💥 Uncaught Exception:"), error.message);
    console.log(chalk.gray(error.stack));
});

process.on("unhandledRejection", (error) => {
    console.log(chalk.red("💥 Unhandled Rejection:"), error.message);
    console.log(chalk.gray(error.stack));
});

// Keep process alive with heartbeat
setInterval(() => {
    const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    console.log(chalk.gray(`⏰ [${now}] Bot is alive | Success: ${successCount} | Failed: ${failCount} | Total: ${totalEarned}฿`));
}, 300000); // ทุก 5 นาที

// Graceful shutdown
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n👋 กำลังปิด bot...'));
    console.log(chalk.cyan('📊 สถิติสุดท้าย:'));
    console.log(chalk.green(`✅ สำเร็จ: ${successCount} ครั้ง`));
    console.log(chalk.red(`❌ ล้มเหลว: ${failCount} ครั้ง`));
    console.log(chalk.magenta(`💰 รวมได้: ${totalEarned}฿`));
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('👋 Render กำลังรีสตาร์ท...'));
    process.exit(0);
});        const qr = new qrcode();
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

// Class สำหรับจัดการ Voucher
class Voucher {
    constructor(phone) { this.phone = phone; }
    
    getQrCode(text) {
        const regex = /v=([a-zA-Z0-9]+)/;
        const match = text.match(regex);
        return match ? match[1] : null;
    }
    
    isSuccess(status) { return status === "SUCCESS"; }
    
    async redeem(voucherCode) {
        const url = `https://discord.gg/cybersafe/topup/angpaofree/before/${voucherCode}/${this.phone}`;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if (this.isSuccess(data.status.message)) return { error: false, data };
            return { error: true, data };
        } catch (error) {
            return { error: true, data: error };
        }
    }
}

// Class สำหรับจัดการ Discord Client (User Account)
class DiscordUserClient {
    constructor(token) {
        this.token = token;
        this.gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';
        this.ws = null;
        this.heartbeatInterval = null;
        this.sessionId = null;
        this.sequence = null;
    }

    connect(messageHandler) {
        const WebSocket = require('ws');
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => console.log(chalk.green('เชื่อมต่อ Discord Gateway สำเร็จ')));

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
                    // Heartbeat ACK
                    break;
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(chalk.red(`Discord ตัดการเชื่อมต่อ: ${code} - ${reason}`));
            clearInterval(this.heartbeatInterval);
            setTimeout(() => this.connect(messageHandler), 5000);
        });

        this.ws.on('error', (error) => console.error(chalk.red('Discord WebSocket Error:'), error.message));
    }

    startHeartbeat(interval) {
        this.heartbeatInterval = setInterval(() => {
            this.send({ op: 1, d: this.sequence });
        }, interval);
    }

    identify() {
        // สำหรับ User Token ต้องใช้ properties ที่เหมือน Discord Client จริงๆ
        this.send({
            op: 2,
            d: {
                token: this.token,
                capabilities: 16381,
                properties: {
                    os: 'Windows',
                    browser: 'Chrome',
                    device: '',
                    system_locale: 'th-TH',
                    browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    browser_version: '120.0.0.0',
                    os_version: '10',
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
                console.log(chalk.green(`===== LOGIN SUCCESS =====`));
                console.log(chalk.cyan(`Logged in as: ${data.user.username}#${data.user.discriminator}`));
                console.log(chalk.cyan(`User ID: ${data.user.id}`));
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

    async sendMessage(channelId, content) {
        try {
            await axios.post(
                `https://discord.com/api/v10/channels/${channelId}/messages`,
                { content },
                { 
                    headers: { 
                        'Authorization': this.token,  // User Token ไม่ต้องใส่ 'Bot' prefix
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    } 
                }
            );
            console.log(chalk.green("ส่งข้อความสำเร็จ"));
        } catch (error) {
            console.error(chalk.red('Error sending message:'), error.response?.data || error.message);
        }
    }
}

// ฟังก์ชันหลักของ Bot
async function main(phone, userToken) {
    const voucher = new Voucher(phone);
    const client = new DiscordUserClient(userToken);
    
    // เก็บประวัติ voucher ที่เคย redeem แล้ว เพื่อไม่ให้ซ้ำ
    const redeemedVouchers = new Set();

    const handleMessage = async (message) => {
        // ข้าม message จาก bot
        if (message.author?.bot) return;

        // ตรวจสอบ voucher code ในข้อความ
        if (message.content) {
            const qrCode = voucher.getQrCode(message.content);
            if (qrCode) {
                // ตรวจสอบว่าเคย redeem แล้วหรือยัง
                if (redeemedVouchers.has(qrCode)) {
                    console.log(chalk.gray(`ข้าม voucher ซ้ำ: ${qrCode}`));
                    return;
                }
                
                console.log(chalk.yellow("🎫 พบ Voucher Code:"), qrCode);
                console.log(chalk.blue("กำลัง redeem..."));
                
                const {error, data} = await voucher.redeem(qrCode);
                
                if (error) {
                    console.log(chalk.red("❌ Failed:"), (data.status?.message || "ไม่สามารถ redeem ได้"));
                } else {
                    console.log(chalk.green("✅ Congrats:"), `${phone} ได้รับ ${data.data.my_ticket.amount_baht}฿ จาก ${data.data.owner_profile.full_name}`);
                    redeemedVouchers.add(qrCode);
                }
            }
        }

        // ตรวจสอบรูปภาพที่แนบมา
        if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
                if (attachment.content_type?.startsWith('image/')) {
                    console.log(chalk.blue("🖼️ พบรูปภาพ กำลังอ่าน QR Code..."));
                    try {
                        const imageData = await getImageFromURL(attachment.url);
                        const decodedQR = await decodeQRFromImage(imageData);
                        const qrCode = voucher.getQrCode(decodedQR);
                        
                        if (qrCode) {
                            // ตรวจสอบว่าเคย redeem แล้วหรือยัง
                            if (redeemedVouchers.has(qrCode)) {
                                console.log(chalk.gray(`ข้าม voucher ซ้ำ: ${qrCode}`));
                                continue;
                            }
                            
                            console.log(chalk.yellow("🎫 พบ Voucher Code จากรูป:"), qrCode);
                            console.log(chalk.blue("กำลัง redeem..."));
                            
                            const {error, data} = await voucher.redeem(qrCode);
                            
                            if (error) {
                                console.log(chalk.red("❌ Failed:"), (data.status?.message || "ไม่สามารถ redeem ได้"));
                            } else {
                                console.log(chalk.green("✅ Congrats:"), `${phone} ได้รับ ${data.data.my_ticket.amount_baht}฿ จาก ${data.data.owner_profile.full_name}`);
                                redeemedVouchers.add(qrCode);
                            }
                        } else {
                            console.log(chalk.gray("ไม่พบ voucher code ในรูปภาพ"));
                        }
                    } catch (error) {
                        console.error(chalk.red("❌ เกิดข้อผิดพลาดในการอ่าน QR Code:"), error.message);
                    }
                }
            }
        }

        // คำสั่งทดสอบ
        if (message.content === "!ping") {
            await client.sendMessage(message.channel_id, "🏓 pong - bot กำลังทำงานอยู่");
        }
    };

    client.connect(handleMessage);
}

console.log(chalk.cyan("===== เริ่มต้น Bot Free Redeem =====\n"));
console.log(chalk.yellow("📱 เบอร์รับเงิน:"), phone);
console.log(chalk.yellow("🔐 กำลัง login เข้า Discord..."));
main(phone, userToken);

// เรียก server เพื่อ keep-alive
keepAlive();

// จัดการ Error ที่ไม่คาดคิด
process.on("uncaughtException", (error) => console.log(chalk.red("💥 Error:"), error.message));
process.on("unhandledRejection", (error) => console.log(chalk.red("💥 Error:"), error.message));
