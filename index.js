const { Client } = require('discord.js-selfbot-v13');
const twvoucher = require('@fortune-inc/tw-voucher');
const { request, Agent } = require('undici');
const { createCanvas, loadImage } = require('canvas');
const jsqr = require('jsqr');
const http = require('http');

const token = process.env.DISCORD_TOKEN;
const phone = process.env.PHONE;
const webhook = process.env.WEBHOOK_URL;

if (!token || !phone || !webhook) {
    console.error("Error: Missing environment variables!");
    process.exit(1);
}

// ===============================================
// ⚡ Undici Dispatcher (ความเร็วสูง)
// ===============================================

const dispatcher = new Agent({ 
    keepAliveTimeout: 900000, 
    pipelining: 100,
    connections: 100
});

// ===============================================
// 🤖 Discord Client (Selfbot)
// ===============================================

const client = new Client({ 
    checkUpdate: false,
    ws: { properties: { $browser: "Discord iOS" } },
    intents: ["GUILDS", "GUILD_MESSAGES"]
});

// ===============================================
// 🖼️ Canvas (สำหรับ QR Code)
// ===============================================

const cvs = createCanvas(1, 1);
const ctx = cvs.getContext('2d', { alpha: false });

// ===============================================
// 🔥 Keep Alive Server
// ===============================================

http.createServer((q, s) => s.end("1")).listen(8080);
setInterval(() => http.get('http://localhost:8080'), 25000);

// ===============================================
// 📊 Stats
// ===============================================

let totalEarned = 0;
let successCount = 0;
let failCount = 0;

// ===============================================
// 💰 Redeem Function (ไม่ผ่าน Proxy)
// ===============================================

async function shot(url, start, imageUrl = null, channelId = null) {
    try {
        const res = await twvoucher(phone, url);
        const ms = ((Date.now() - start) / 1000).toFixed(2);
        const amount = res.amount || 0;
        
        totalEarned += parseFloat(amount);
        successCount++;
        
        console.log(`[+] ${amount}฿ | ${ms}s`);
        
        // ส่ง Webhook (ไม่รอ)
        const embed = {
            title: "✅ รีดีมสำเร็จ",
            color: 0x00ff00,
            fields: [
                { name: "💰 จำนวน", value: `${amount}฿`, inline: true },
                { name: "⚡ ความเร็ว", value: `${ms}s`, inline: true },
                { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
            ],
            timestamp: new Date().toISOString()
        };
        
        if (imageUrl) {
            embed.thumbnail = { url: imageUrl };
            embed.fields.unshift({ name: "📷 ประเภท", value: "QR Code", inline: true });
        }
        
        if (channelId) {
            embed.footer = { text: `Channel ID: ${channelId}` };
        }
        
        request(webhook, {
            method: 'POST',
            dispatcher,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        }).catch(() => {});
        
    } catch (error) {
        const ms = ((Date.now() - start) / 1000).toFixed(2);
        failCount++;
        
        console.log(`[-] Failed | ${ms}s`);
        
        // ส่ง Webhook ล้มเหลว (ไม่รอ)
        const embed = {
            title: "❌ รีดีมล้มเหลว",
            color: 0xff0000,
            fields: [
                { name: "📝 สาเหตุ", value: error.message || 'Unknown', inline: false },
                { name: "⚡ ความเร็ว", value: `${ms}s`, inline: true },
                { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
            ],
            timestamp: new Date().toISOString()
        };
        
        if (imageUrl) {
            embed.thumbnail = { url: imageUrl };
        }
        
        request(webhook, {
            method: 'POST',
            dispatcher,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        }).catch(() => {});
    }
}

// ===============================================
// 📩 Message Handler
// ===============================================

client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    
    const start = Date.now();
    const c = msg.content;
    const channelId = msg.channelId;

    // ตรวจสอบข้อความ
    if (c.includes('v=')) {
        const v = c.indexOf('v=');
        const code = c.substring(v + 2, v + 20).split(/[ \n?&]/)[0];
        if (code.length >= 10) {
            return shot(`https://gift.truemoney.com/campaign/?v=${code}`, start, null, channelId);
        }
    }

    // ตรวจสอบรูปภาพ (Parallel Processing)
    const imagePromises = [];
    
    // Attachments
    if (msg.attachments.size > 0) {
        for (const [, at] of msg.attachments) {
            if (at.contentType?.includes('image')) {
                imagePromises.push(
                    loadImage(at.url)
                        .then(img => {
                            cvs.width = img.width;
                            cvs.height = img.height;
                            ctx.drawImage(img, 0, 0);
                            const qr = jsqr(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
                            if (qr?.data) {
                                shot(qr.data, start, at.url, channelId);
                            }
                        })
                        .catch(() => {})
                );
            }
        }
    }
    
    // Embeds
    if (msg.embeds?.length > 0) {
        for (const embed of msg.embeds) {
            const urls = [embed.image?.url, embed.thumbnail?.url].filter(Boolean);
            
            for (const url of urls) {
                imagePromises.push(
                    loadImage(url)
                        .then(img => {
                            cvs.width = img.width;
                            cvs.height = img.height;
                            ctx.drawImage(img, 0, 0);
                            const qr = jsqr(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
                            if (qr?.data) {
                                shot(qr.data, start, url, channelId);
                            }
                        })
                        .catch(() => {})
                );
            }
        }
    }
    
    // รอทุก promise พร้อมกัน
    if (imagePromises.length > 0) {
        await Promise.allSettled(imagePromises);
    }
});

// ===============================================
// 🟢 Ready Event
// ===============================================

client.on("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📱 Phone: ${phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2')}`);
    console.log(`⚡ Mode: Direct (No Proxy)`);
    
    // ส่ง Webhook เริ่มทำงาน
    request(webhook, {
        method: 'POST',
        dispatcher,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title: "🟢 Bot เริ่มทำงาน",
                color: 0x00ff00,
                fields: [
                    { name: "👤 Username", value: client.user.tag, inline: true },
                    { name: "📱 Phone", value: phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2'), inline: true },
                    { name: "🔧 Mode", value: "Direct (No Proxy)", inline: true }
                ],
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
});

// ===============================================
// 🛑 Error Handling
// ===============================================

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

// Restart ทุก 1 ชั่วโมง
setInterval(() => {
    console.log('🔄 Restarting...');
    request(webhook, {
        method: 'POST',
        dispatcher,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title: "🔄 Bot Restart",
                color: 0xffa500,
                fields: [
                    { name: "📊 สถิติก่อน Restart", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                ],
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
    
    setTimeout(() => process.exit(0), 1000);
}, 3600000);

// Shutdown Gracefully
process.on('SIGTERM', () => {
    request(webhook, {
        method: 'POST',
        dispatcher,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title: "🔴 Bot หยุดทำงาน",
                color: 0xff0000,
                fields: [
                    { name: "📊 สถิติสุดท้าย", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                ],
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
    
    setTimeout(() => process.exit(0), 500);
});

process.on('SIGINT', () => {
    request(webhook, {
        method: 'POST',
        dispatcher,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title: "🔴 Bot หยุดทำงาน",
                color: 0xff0000,
                fields: [
                    { name: "📊 สถิติสุดท้าย", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                ],
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
    
    setTimeout(() => process.exit(0), 500);
});

// ===============================================
// 🚀 Login
// ===============================================

client.login(token);
