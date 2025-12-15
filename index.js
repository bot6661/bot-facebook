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
const discordToken = process.env.DISCORD_TOKEN;

if (!discordToken) {
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

// Class สำหรับจัดการ Discord Client
class DiscordClient {
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
        this.heartbeatInterval = setInterval(() => this.send({ op: 1, d: this.sequence }), interval);
    }

    identify() {
        this.send({
            op: 2,
            d: {
                token: this.token,
                properties: { $os: 'linux', $browser: 'chrome', $device: 'pc' },
                intents: 513
            }
        });
    }

    handleDispatch(eventName, data, messageHandler) {
        switch (eventName) {
            case 'READY':
                console.log(chalk.green(`===== LOGIN SUCCESS =====`));
                console.log(chalk.cyan(`Logged in as: ${data.user.username}#${data.user.discriminator}`));
                this.sessionId = data.session_id;
                break;
            case 'MESSAGE_CREATE':
                messageHandler(data);
                break;
        }
    }

    send(payload) {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload));
    }

    async sendMessage(channelId, content) {
        try {
            await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`,
                { content },
                { headers: { 'Authorization': this.token, 'Content-Type': 'application/json' } }
            );
        } catch (error) {
            console.error(chalk.red('Error sending message:'), error.response?.data || error.message);
        }
    }
}

// ฟังก์ชันหลักของ Bot
async function main(phone, discordToken) {
    const voucher = new Voucher(phone);
    const client = new DiscordClient(discordToken);

    const handleMessage = async (message) => {
        if (message.author?.bot) return;

        if (message.content) {
            const qrCode = voucher.getQrCode(message.content);
            if (qrCode) {
                console.log(chalk.yellow("พบ Voucher Code:"), qrCode);
                const {error, data} = await voucher.redeem(qrCode);
                if (error) console.log(chalk.red("Failed:"), (data.status?.message || "ไม่สามารถ redeem ได้"));
                else console.log(chalk.green("Congrats:"), phone + " received " + data.data.my_ticket.amount_baht + "฿ from " + data.data.owner_profile.full_name);
            }
        }

        if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
                if (attachment.content_type?.startsWith('image/')) {
                    console.log(chalk.blue("พบรูปภาพ กำลังอ่าน QR Code..."));
                    try {
                        const imageData = await getImageFromURL(attachment.url);
                        const decodedQR = await decodeQRFromImage(imageData);
                        const qrCode = voucher.getQrCode(decodedQR);
                        if (qrCode) {
                            console.log(chalk.yellow("พบ Voucher Code จากรูป:"), qrCode);
                            const {error, data} = await voucher.redeem(qrCode);
                            if (error) console.log(chalk.red("Failed:"), (data.status?.message || "ไม่สามารถ redeem ได้"));
                            else console.log(chalk.green("Congrats:"), phone + " received " + data.data.my_ticket.amount_baht + "฿ from " + data.data.owner_profile.full_name);
                        }
                    } catch (error) {
                        console.error(chalk.red("เกิดข้อผิดพลาดในการอ่าน QR Code:"), error.message);
                    }
                }
            }
        }

        if (message.content === "!ping") {
            await client.sendMessage(message.channel_id, "pong - bot กำลังทำงานอยู่");
        }
    };

    client.connect(handleMessage);
}

console.log(chalk.cyan("===== bot free redeem discord =====\n"));
console.log(chalk.yellow("เบอร์รับเงิน:"), phone);
console.log(chalk.yellow("กำลัง login เข้า Discord..."));
main(phone, discordToken);

// เรียก server เพื่อ keep-alive
keepAlive();

// จัดการ Error ที่ไม่คาดคิด
process.on("uncaughtException", (error) => console.log(chalk.red("Error:"), error.message));
process.on("unhandledRejection", (error) => console.log(chalk.red("Error:"), error.message));
