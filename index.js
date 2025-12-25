const { Client } = require('discord.js-selfbot-v13');
const { request, Agent } = require('undici');
const { createCanvas, loadImage } = require('canvas');
const jsqr = require('jsqr');
const axios = require('axios');

const keepAlive = require('./server.js');

const token = process.env.DISCORD_TOKEN;
const phone = process.env.PHONE;
const webhook = process.env.WEBHOOK_URL;
const PROXY_URL = 'https://truewalletproxy-755211536068837409.rcf2.deploys.app/api';

if (!token || !phone || !webhook) {
    console.error("Error: Missing environment variables!");
    process.exit(1);
}

const dispatcher = new Agent({ 
    keepAliveTimeout: 900000, 
    pipelining: 100,
    connections: 100
});

const client = new Client({ 
    checkUpdate: false,
    ws: { properties: { $browser: "Discord iOS" } },
    intents: ["GUILDS", "GUILD_MESSAGES"]
});

const cvs = createCanvas(1, 1);
const ctx = cvs.getContext('2d', { alpha: false });

let totalEarned = 0;
let successCount = 0;
let failCount = 0;

function getVoucherCode(text) {
    if (!text) return null;
    const match = text.match(/v=([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

async function shot(url, start, imageUrl = null) {
    const voucherCode = getVoucherCode(url) || url.split('/').pop().split('?')[0];
    
    axios.post(PROXY_URL, {
        mobile: phone,
        voucher: voucherCode
    }, {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'multilabxxxxxxxx'
        },
        timeout: 5000,
        validateStatus: () => true
    }).then(response => {
        const data = response.data;
        const ms = ((Date.now() - start) / 1000).toFixed(2);
        
        if (data?.status?.code === 'SUCCESS') {
            const amount = Number(data.data.my_ticket.amount_baht.replace(/,/g, ""));
            const ownerName = data.data.owner_profile.full_name || 'Unknown';
            
            totalEarned += amount;
            successCount++;
            
            console.log(`[+] ${amount}฿ | ${ms}s`);
            
            const embed = {
                title: "✅ รีดีมสำเร็จ",
                color: 0x00ff00,
                fields: [
                    { name: "💰 จำนวน", value: `${amount}฿`, inline: true },
                    { name: "👤 จาก", value: ownerName, inline: true },
                    { name: "⚡ ความเร็ว", value: `${ms}s`, inline: true },
                    { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                ],
                timestamp: new Date().toISOString()
            };
            
            if (imageUrl) embed.thumbnail = { url: imageUrl };
            
            request(webhook, {
                method: 'POST',
                dispatcher,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] })
            }).catch(() => {});
            
        } else {
            const message = data?.status?.message || data?.status?.code || 'Failed';
            failCount++;
            
            console.log(`[-] ${message} | ${ms}s`);
            
            const embed = {
                title: "❌ รีดีมล้มเหลว",
                color: 0xff0000,
                fields: [
                    { name: "📝 สาเหตุ", value: message, inline: false },
                    { name: "⚡ ความเร็ว", value: `${ms}s`, inline: true },
                    { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
                ],
                timestamp: new Date().toISOString()
            };
            
            if (imageUrl) embed.thumbnail = { url: imageUrl };
            
            request(webhook, {
                method: 'POST',
                dispatcher,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] })
            }).catch(() => {});
        }
    }).catch(err => {
        const ms = ((Date.now() - start) / 1000).toFixed(2);
        failCount++;
        
        console.log(`[-] ${err.message || 'Error'} | ${ms}s`);
        
        const embed = {
            title: "❌ รีดีมล้มเหลว",
            color: 0xff0000,
            fields: [
                { name: "📝 สาเหตุ", value: err.message || 'Unknown', inline: false },
                { name: "⚡ ความเร็ว", value: `${ms}s`, inline: true },
                { name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }
            ],
            timestamp: new Date().toISOString()
        };
        
        if (imageUrl) embed.thumbnail = { url: imageUrl };
        
        request(webhook, {
            method: 'POST',
            dispatcher,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        }).catch(() => {});
    });
}

client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    
    const start = Date.now();
    const c = msg.content;

    if (c.includes('v=')) {
        const v = c.indexOf('v=');
        const code = c.substring(v + 2, v + 20).split(/[ \n?&]/)[0];
        if (code.length >= 10) return shot(`https://gift.truemoney.com/campaign/?v=${code}`, start);
    }

    // Attachments
    if (msg.attachments.size > 0) {
        const at = msg.attachments.first();
        if (at.contentType?.includes('image')) {
            loadImage(at.url).then(img => {
                cvs.width = img.width;
                cvs.height = img.height;
                ctx.drawImage(img, 0, 0);
                const qr = jsqr(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
                if (qr?.data) shot(qr.data, start, at.url);
            }).catch(() => {});
        }
    }

    // Embeds
    if (msg.embeds?.length > 0) {
        for (const embed of msg.embeds) {
            const urls = [embed.image?.url, embed.thumbnail?.url].filter(Boolean);
            for (const url of urls) {
                loadImage(url).then(img => {
                    cvs.width = img.width;
                    cvs.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    const qr = jsqr(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
                    if (qr?.data) shot(qr.data, start, url);
                }).catch(() => {});
            }
        }
    }
});

client.on("ready", () => {
    console.log(`✅ ${client.user.tag}`);
    console.log(`📱 ${phone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2')}`);
    console.log(`🔧 Mode: PROXY`);
    
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
                    { name: "🔧 Mode", value: "PROXY (Anti-Block)", inline: true }
                ],
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

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
                fields: [{ name: "📊 สถิติ", value: `✅${successCount} ❌${failCount} 💰${totalEarned}฿`, inline: false }],
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
    setTimeout(() => process.exit(0), 1000);
}, 3600000);

keepAlive();
client.login(token);
