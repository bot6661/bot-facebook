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
        const response = await axios.get(url, {'responseType': "arraybuffer", timeout: 5000});
        return response.data;
    } catch (error) {
        console.error(chalk.red("Error fetching image:"), error.message);
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
        console.error(chalk.red("Error decoding QR:"), error.message);
        throw error;
    }
}

// Class สำหรับจัดการ Voucher (เวอร์ชั่นหลบ Cloudflare + เร็วสุด)
class Voucher {
    constructor(phone) { 
        this.phone = phone;
        // 🛡️ Headers แบบเบราว์เซอร์จริงๆ เพื่อหลบ Cloudflare
        this.headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Origin': 'https://gift.truemoney.com',
            'Referer': 'https://gift.truemoney.com/',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };
    }
    
    // ดึง voucher code จาก URL
    getQrCode(text) {
        const regex = /v=([a-zA-Z0-9]+)/;
        const match = text.match(regex);
        return match ? match[1] : null;
    }
    
    // ⚡ Redeem แบบเร็วสุด + หลบ Cloudflare
    async redeem(voucherCode) {
        const url = `https://gift.truemoney.com/campaign/vouchers/${voucherCode}/redeem`;
        const startTime = Date.now();
        
        try {
            // ⚡ ส่ง Request พร้อม Headers แบบเบราว์เซอร์จริง
            const response = await axios.post(url, {
                mobile: this.phone,
                voucher_hash: voucherCode
            }, {
                headers: this.headers,
                timeout: 5000, // ⚡ 5 วินาที
                maxRedirects: 5, // อนุญาตให้ redirect
                validateStatus: (status) => status < 500,
                // 🛡️ เพิ่ม config เพื่อหลบ Cloudflare
                decompress: true,
                httpAgent: null,
                httpsAgent: null
            });
            
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            const data = response.data;
            
            // ตรวจสอบว่าโดน Cloudflare block หรือไม่
            if (typeof data === 'string' && data.includes('cloudflare')) {
                console.log(chalk.red("⚠️ ถูก Cloudflare บล็อก - กำลังลองใหม่..."));
                
                // รอ 2 วินาทีแล้วลองใหม่
                await new Promise(resolve => setTimeout(resolve, 2000));
                return await this.redeem(voucherCode);
            }
            
            // ⚡ ตรวจสอบผลลัพธ์เร็วๆ
            if (data?.status?.code === "SUCCESS") {
                return { 
                    error: false, 
                    amount: data.data?.amount_baht || data.data?.voucher?.amount_baht || 0,
                    owner: data.data?.owner_profile?.full_name || data.data?.redeemer?.name || "ไม่ทราบชื่อ",
                    duration: duration,
                    status: response.status,
                    raw: data
                };
            }
            
            return { 
                error: true, 
                message: data?.status?.message || data?.message || "ไม่สำเร็จ",
                duration: duration,
                status: response.status,
                raw: data
            };
            
        } catch (error) {
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            // ตรวจสอบว่าโดน Cloudflare หรือไม่
            if (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes('cloudflare')) {
                console.log(chalk.red("⚠️ ถูก Cloudflare บล็อก - กำลังลองใหม่..."));
                
                // รอ 2 วินาทีแล้วลองใหม่
                await new Promise(resolve => setTimeout(resolve, 2000));
                return await this.redeem(voucherCode);
            }
            
            return { 
                error: true, 
                message: error.response?.data?.status?.message || error.response?.data?.message || error.message,
                duration: duration,
                status: error.response?.status || 0,
                raw: error.response?.data || null
            };
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
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    connect(messageHandler) {
        const WebSocket = require('ws');
        
        console.log(chalk.yellow(`🔄 กำลังเชื่อมต่อ Discord... (ครั้งที่ ${this.reconnectAttempts + 1})`));
        
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
            console.log(chalk.green('✅ เชื่อมต่อ Discord Gateway สำเร็จ'));
            this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                const { op, d, s, t } = payload;
                if (s) this.sequence = s;

                switch (op) {
                    case 10:
                        console.log(chalk.blue('📡 ได้รับ Hello จาก Discord'));
                        this.startHeartbeat(d.heartbeat_interval);
                        this.identify();
                        break;
                    case 0:
                        this.handleDispatch(t, d, messageHandler);
                        break;
                    case 11:
                        // Heartbeat ACK
                        break;
                    case 9:
                        console.log(chalk.red('❌ Invalid Session - กำลัง reconnect...'));
                        this.reconnect(messageHandler);
                        break;
                }
            } catch (error) {
                console.error(chalk.red('Error parsing message:'), error.message);
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(chalk.red(`❌ Discord ตัดการเชื่อมต่อ: ${code} - ${reason || 'No reason'}`));
            clearInterval(this.heartbeatInterval);
            this.reconnect(messageHandler);
        });

        this.ws.on('error', (error) => {
            console.error(chalk.red('💥 Discord WebSocket Error:'), error.message);
        });
    }

    reconnect(messageHandler) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(chalk.red('❌ ไม่สามารถเชื่อมต่อได้หลังจากพยายามหลายครั้ง'));
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        
        console.log(chalk.yellow(`⏳ จะ reconnect ในอีก ${delay/1000} วินาที...`));
        
        setTimeout(() => {
            this.connect(messageHandler);
        }, delay);
    }

    startHeartbeat(interval) {
        console.log(chalk.blue(`💓 เริ่ม Heartbeat (ทุก ${interval}ms)`));
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                this.send({ op: 1, d: this.sequence });
            }
        }, interval);
    }

    identify() {
        console.log(chalk.blue('🔐 กำลัง Identify...'));
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
                console.log(chalk.green(`\n===== ✅ LOGIN SUCCESS =====`));
                console.log(chalk.cyan(`👤 Username: ${data.user.username}#${data.user.discriminator}`));
                console.log(chalk.cyan(`🆔 User ID: ${data.user.id}`));
                console.log(chalk.cyan(`📧 Email: ${data.user.email || 'N/A'}`));
                console.log(chalk.green(`===== Bot พร้อมทำงาน =====\n`));
                this.sessionId = data.session_id;
                break;
            case 'MESSAGE_CREATE':
                messageHandler(data);
                break;
            case 'RESUMED':
                console.log(chalk.green('✅ Resume session สำเร็จ'));
                break;
        }
    }

    send(payload) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.error(chalk.red('❌ WebSocket ไม่พร้อม ไม่สามารถส่งข้อมูลได้'));
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
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 5000
                }
            );
            console.log(chalk.green("✅ ส่งข้อความสำเร็จ"));
        } catch (error) {
            console.error(chalk.red('❌ Error sending message:'), error.response?.data || error.message);
        }
    }
}

// ฟังก์ชันหลักของ Bot
async function main(phone, userToken) {
    const voucher = new Voucher(phone);
    const client = new DiscordUserClient(userToken);
    
    const redeemedVouchers = new Set();

    const handleMessage = async (message) => {
        try {
            if (message.author?.bot) return;

            // ตรวจสอบ voucher code ในข้อความ
            if (message.content) {
                const qrCode = voucher.getQrCode(message.content);
                if (qrCode) {
                    if (redeemedVouchers.has(qrCode)) {
                        console.log(chalk.gray(`⏭️ ข้าม voucher ซ้ำ: ${qrCode}`));
                        return;
                    }
                    
                    console.log(chalk.yellow("\n" + "=".repeat(60)));
                    console.log(chalk.yellow("🎫 พบ Voucher:"), qrCode);
                    console.log(chalk.cyan("⚡ กำลัง Redeem..."));
                    
                    const result = await voucher.redeem(qrCode);
                    
                    if (result.error) {
                        console.log(chalk.red("❌ Redeem ไม่สำเร็จ!"));
                        console.log(chalk.red("สาเหตุ:"), result.message);
                        console.log(chalk.gray(`⏱️ ใช้เวลา: ${result.duration}ms`));
                        console.log(chalk.gray(`📡 Status Code: ${result.status}`));
                    } else {
                        console.log(chalk.green("✅ Redeem สำเร็จ!"));
                        console.log(chalk.green(`💰 ${phone} ได้รับ ${result.amount}฿`));
                        console.log(chalk.green(`👤 จาก: ${result.owner}`));
                        console.log(chalk.cyan(`⚡ ใช้เวลา: ${result.duration}ms`));
                        redeemedVouchers.add(qrCode);
                    }
                    console.log(chalk.yellow("=".repeat(60) + "\n"));
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
                                if (redeemedVouchers.has(qrCode)) {
                                    console.log(chalk.gray(`⏭️ ข้าม voucher ซ้ำ: ${qrCode}`));
                                    continue;
                                }
                                
                                console.log(chalk.yellow("\n" + "=".repeat(60)));
                                console.log(chalk.yellow("🎫 พบ Voucher (จากรูป):"), qrCode);
                                console.log(chalk.cyan("⚡ กำลัง Redeem..."));
                                
                                const result = await voucher.redeem(qrCode);
                                
                                if (result.error) {
                                    console.log(chalk.red("❌ Redeem ไม่สำเร็จ!"));
                                    console.log(chalk.red("สาเหตุ:"), result.message);
                                    console.log(chalk.gray(`⏱️ ใช้เวลา: ${result.duration}ms`));
                                } else {
                                    console.log(chalk.green("✅ Redeem สำเร็จ!"));
                                    console.log(chalk.green(`💰 ${phone} ได้รับ ${result.amount}฿`));
                                    console.log(chalk.green(`👤 จาก: ${result.owner}`));
                                    console.log(chalk.cyan(`⚡ ใช้เวลา: ${result.duration}ms`));
                                    redeemedVouchers.add(qrCode);
                                }
                                console.log(chalk.yellow("=".repeat(60) + "\n"));
                            } else {
                                console.log(chalk.gray("❌ ไม่พบ voucher code ในรูปภาพ"));
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
        } catch (error) {
            console.error(chalk.red("❌ Error in handleMessage:"), error.message);
            console.error(error.stack);
        }
    };

    client.connect(handleMessage);
}

console.log(chalk.cyan("\n===== 🚀 เริ่มต้น Bot Free Redeem ====="));
console.log(chalk.yellow("📱 เบอร์รับเงิน:"), phone);
console.log(chalk.yellow("🔐 กำลัง login เข้า Discord...\n"));

keepAlive();

setTimeout(() => {
    main(phone, userToken);
}, 2000);

process.on("uncaughtException", (error) => {
    console.log(chalk.red("💥 Uncaught Exception:"), error.message);
    console.error(error.stack);
});

process.on("unhandledRejection", (error) => {
    console.log(chalk.red("💥 Unhandled Rejection:"), error.message);
    console.error(error.stack);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow('📴 ได้รับสัญญาณ SIGTERM - กำลังปิดโปรแกรม...'));
    process.exit(0);
});

console.log(chalk.green("✅ Server พร้อมทำงาน - รอการเชื่อมต่อ Discord..."));
