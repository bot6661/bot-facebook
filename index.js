const chalk = require("chalk");
const fs = require('fs');
const axios = require("axios");
const jimp = require("jimp-compact");
const qrcode = require("qrcode-reader");

const keepAlive = require("./server.js");

console.clear();
process.env.TZ = "Asia/Bangkok";

console.log(chalk.cyan("\n===== bot free redeem discord =====\n"));

// อ่าน token และ phone จาก Environment Variables
const phone = process.env.PHONE || "0959426013";
const userToken = process.env.DISCORD_TOKEN;

if (!userToken) {
    console.error(chalk.red("Error: DISCORD_TOKEN ไม่ถูกตั้งค่า!"));
    process.exit(1);
}

// ฟังก์ชันดึงรูปภาพจาก URL
async function getImageFromURL(url) {
    try {
        const response = await axios.get(url, {'responseType': "arraybuffer"});
        return response.data;
    } catch (error) {
        throw error;
    }
}

// ฟังก์ชันอ่าน QR Code จากรูปภาพ
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
