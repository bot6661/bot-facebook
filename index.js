const fs = require('fs');
let login = require("fca-unofficial");
const axios = require("axios");
const jimp = require("jimp-compact");
const Jimp = require("jimp");
const qrcode = require("qrcode-reader");
const express = require('express'); // เพิ่มบรรทัดนี้

console.clear();
process.env.TZ = "Asia/Bangkok";

// Banner
console.log("\n=================================================");
console.log("        BOT FREE REDEEM TRUEMONEY (FB)");
console.log("=================================================\n");

// ⭐ เพิ่มส่วน Express Server สำหรับ Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>TrueMoney Bot</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>🟢 Bot is Running!</h1>
        <p>TrueMoney Redeem Bot is active</p>
        <p>Phone: 0959426013</p>
        <p>Status: Online</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});

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
                if (err) {
                    reject(err);
                }
                resolve(value);
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
    constructor(phone) {
        this.phone = phone;
    }

    getQrCode(text) {
        if (!text) return null;
        const regex = /v=([a-zA-Z0-9]+)/;
        const match = text.match(regex);
        if (match) {
            return match[1];
        }
        return null;
    }

    isSuccess(status) {
        return status == "SUCCESS";
    }

    async redeem(voucherCode) {
        const url = "https://discord.gg/cybersafe/topup/angpaofree/before/" + voucherCode + '/' + this.phone;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if (this.isSuccess(data.status.message)) {
                return {'error': false, 'data': data};
            }
            return {'error': true, 'data': data};
        } catch (error) {
            return {'error': true, 'data': error};
        }
    }
}

// ฟังก์ชันปิดโปรแกรม
async function cleanupAndExit(code) {
    console.log("[EXIT] กำลังปิดโปรแกรม...");
    process.exit(code);
}

// ฟังก์ชันหลักของ Bot
async function main(phone, appState) {
    const voucher = new Voucher(phone);

    login({'appState': appState}, async (error, api) => {
        if (error) {
            console.log("[ERROR] Login Failed:", error);
            await cleanupAndExit(1);
        }
        console.log("[SUCCESS] Login เข้า Facebook สำเร็จ!");
        console.log("[INFO] Bot กำลังทำงาน... รอรับ Voucher\n");

        api.listen(async (err, message) => {
            if (err) {
                console.log("[ERROR] Listen Error:", err);
                return;
            }

            // กดอ่านข้อความทุกแชทอัตโนมัติ
            if (message.threadID) {
                try {
                    api.markAsRead(message.threadID);
                } catch (e) {
                    // ไม่ต้องแสดง error
                }
            }

            if (message.type == "message") {
                
                // กรณีที่เป็นข้อความธรรมดา
                if (message.body) {
                    const qrCode = voucher.getQrCode(message.body);
                    if (qrCode != null) {
                        console.log("[VOUCHER] พบรหัส:", qrCode);
                        console.log("[PROCESS] กำลัง Redeem...");
                        
                        const {error, data} = await voucher.redeem(qrCode);
                        
                        if (error) {
                            console.log("[FAILED]", (data.status?.message || data.message || "ไม่สามารถ redeem ได้"));
                        } else {
                            console.log("[SUCCESS] รับเงินสำเร็จ!");
                            console.log("  - เบอร์:", phone);
                            console.log("  - จำนวน:", data.data.my_ticket.amount_baht + "฿");
                            console.log("  - จาก:", data.data.owner_profile.full_name);
                        }
                        console.log("");
                    }
                }

                // กรณีที่เป็นรูปภาพ
                if (message.attachments && message.attachments.length > 0 && message.attachments[0].type == "photo") {
                    console.log("[IMAGE] พบรูปภาพ กำลังอ่าน QR Code...");
                    try {
                        const imageData = await getImageFromURL(message.attachments[0].url);
                        const decodedQR = await decodeQRFromImage(imageData);
                        const qrCode = voucher.getQrCode(decodedQR);

                        if (qrCode != null) {
                            console.log("[VOUCHER] พบรหัสจากรูป:", qrCode);
                            console.log("[PROCESS] กำลัง Redeem...");
                            
                            const {error, data} = await voucher.redeem(qrCode);
                            
                            if (error) {
                                console.log("[FAILED]", (data.status?.message || data.message || "ไม่สามารถ redeem ได้"));
                            } else {
                                console.log("[SUCCESS] รับเงินสำเร็จ!");
                                console.log("  - เบอร์:", phone);
                                console.log("  - จำนวน:", data.data.my_ticket.amount_baht + "฿");
                                console.log("  - จาก:", data.data.owner_profile.full_name);
                            }
                            console.log("");
                        } else {
                            console.log("[INFO] ไม่พบรหัส Voucher ในรูปภาพ");
                        }
                    } catch (error) {
                        console.error("[ERROR] อ่าน QR Code ไม่สำเร็จ:", error.message);
                    }
                }

                // คำสั่ง ping
                if (message.body && message.body.toLowerCase() == "ping") {
                    api.sendMessage("🟢 pong - bot กำลังทำงานอยู่", message.threadID);
                    console.log("[PING] ตอบกลับคำสั่ง ping");
                }
            }
        });
    });
}

// เริ่มต้นโปรแกรม
console.log("[START] กำลังเริ่มต้น Bot...\n");

const phone = "0959426013";
console.log("[CONFIG] เบอร์รับเงิน:", phone);
console.log("[CONFIG] กำลัง login เข้า Facebook...\n");

try {
    const appState = JSON.parse(fs.readFileSync("appState.json", "utf8"));
    main(phone, appState);
} catch (error) {
    console.log("[ERROR] ไม่พบไฟล์ appState.json หรืออ่านไม่ได้");
    console.log("[ERROR]", error.message);
    process.exit(1);
}

// จัดการ Error
process.on("uncaughtException", async (error) => {
    console.log("[ERROR]", error.message);
    console.log("[INFO] Bot จะพยายาม Reconnect ใน 5 วินาที...\n");
    setTimeout(() => {
        try {
            const appState = JSON.parse(fs.readFileSync("appState.json", "utf8"));
            main(phone, appState);
        } catch (e) {
            console.log("[ERROR] Reconnect ไม่สำเร็จ");
        }
    }, 5000);
});

process.on("unhandledRejection", async (error) => {
    console.log("[ERROR]", error.message);
    console.log("[INFO] Bot จะพยายาม Reconnect ใน 5 วินาที...\n");
    setTimeout(() => {
        try {
            const appState = JSON.parse(fs.readFileSync("appState.json", "utf8"));
            main(phone, appState);
        } catch (e) {
            console.log("[ERROR] Reconnect ไม่สำเร็จ");
        }
    }, 5000);
});
