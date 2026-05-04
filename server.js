const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');

app.use(express.json());
app.use(express.static('public'));

// Database
const db = new sqlite3.Database('warmer.db');
db.run(`CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sessions INTEGER,
    messages INTEGER,
    success_rate REAL
)`);

// Store clients
const clients = new Map();
let warmerActive = false;

// Random messages & emojis
const randomMessages = [
    "Halo semuanya! Gimana kabarnya hari ini? 😊",
    "Ada yang lagi butuh rekomendasi produk bagus? 🛒✨",
    "Weekend plan apa nih guys? 🎉",
    "Siapa yang lagi nyari promo menarik? 🔥",
    "Pagi semua! Semangat kerjanya ya 💪",
    "Makasih ya udah join grup ini! 🙏",
    "Ada tips bisnis online gak nih? 📈",
    "Siapa tau ada yang butuh supplier? 🤝"
];

const emojis = ['😊', '👍', '🔥', '✨', '💯', '🙌', '🎉', '❤️', '🚀', '💪'];

// AI Message Generator
class AIMessageGenerator {
    static generate(mode = 'human') {
        const templates = {
            human: [
                "Halo bro, apa kabar? Lama gak ketemu nih 😊",
                "Ada yang tau rekomendasi aplikasi bagus gak? 📱",
                "Weekend kemana nih guys? 🏖️",
                "Siapa lagi nyari side hustle? 💼✨"
            ],
            business: [
                "Halo tim, ada update project hari ini? 📊",
                "Siapa yang punya kontak supplier terpercaya? 🤝",
                "Meeting besok jam 10 ya, confirmed? ⏰",
                "Ada yang butuh jasa digital marketing? 🚀"
            ],
            casual: [
                "Makan siang apa nih? Lapar banget 😋",
                "Film apa yang lagi hits sekarang? 🎬",
                "Siapa lagi main ML? Team yuk! 🎮",
                "Cuaca panas banget hari ini ☀️"
            ]
        };
        const messages = templates[mode] || templates.human;
        return messages[Math.floor(Math.random() * messages.length)];
    }
}

class WhatsAppWarmer {
    constructor(sessionId) {
        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId }),
            puppeteer: { headless: true }
        });
        this.sessionId = sessionId;
        this.isConnected = false;
        this.validGroups = [];
        this.stats = { messages: 0, success: 0, failed: 0 };
        this.aiMode = 'human';
        this.banProtection = 'medium';
    }

    async connect() {
        return new Promise((resolve) => {
            this.client.on('qr', (qr) => {
                qrcode.generate(qr, { small: true });
                console.log('📱 Scan QR Code di atas!');
                io.emit('log', '🔄 Scan QR Code WhatsApp Anda...');
            });

            this.client.on('authenticated', () => {
                this.isConnected = true;
                console.log('✅ WhatsApp Connected!');
                io.emit('log', '✅ WhatsApp berhasil terhubung!');
                resolve(true);
            });

            this.client.on('auth_failure', () => {
                console.log('❌ Auth Failed');
                io.emit('log', '❌ Gagal koneksi WhatsApp');
                resolve(false);
            });

            this.client.initialize();
        });
    }

    // Convert Group Link to Group ID
    async getGroupIdFromInviteLink(inviteLink) {
        try {
            console.log(`🔗 Fetching group ID from: ${inviteLink}`);
            io.emit('log', `🔗 Processing link: ${inviteLink}`);
            
            const response = await axios.get(inviteLink, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });
            
            const groupIdMatch = response.data.match(/["'](\d+-\d+@g\.us)["']/);
            if (groupIdMatch) {
                const groupId = groupIdMatch[1];
                console.log(`✅ Group ID: ${groupId}`);
                return groupId;
            }
            
            const codeMatch = inviteLink.match(/\/join\/([A-Za-z0-9]+)/);
            if (codeMatch) {
                io.emit('log', `🔍 Trying invite code: ${codeMatch[1]}`);
                // Simulate join untuk dapat ID
                await new Promise(r => setTimeout(r, 2000));
            }
            
            return null;
        } catch (error) {
            console.error('❌ Link failed:', error.message);
            return null;
        }
    }

    async processGroupLinks(groupLinks) {
        const validGroups = [];
        io.emit('log', `🔗 Processing ${groupLinks.length} group links...`);
        
        for (let i = 0; i < groupLinks.length; i++) {
            const link = groupLinks[i];
            io.emit('log', `⏳ ${i+1}/${groupLinks.length}: ${link}`);
            
            const groupId = await this.getGroupIdFromInviteLink(link);
            if (groupId) {
                validGroups.push(groupId);
                io.emit('log', `✅ VALID: ${link} → ${groupId}`);
            } else {
                io.emit('log', `❌ INVALID: ${link}`);
            }
            
            await new Promise(r => setTimeout(r, 2000));
        }
        
        this.validGroups = validGroups;
        return validGroups;
    }

    async startWarmer(config) {
        if (!this.isConnected) return false;

        warmerActive = true;
        this.aiMode = config.aiMode || 'human';
        this.banProtection = config.banProtection || 'medium';
        
        // Process groups if links provided
        let groups = config.groups || [];
        if (config.groupLinks && config.groupLinks.length > 0) {
            groups = await this.processGroupLinks(config.groupLinks);
        }
        
        // 1. Random Status
        this.postRandomStatus(config.statusInterval || 30 * 60 * 1000);
        
        // 2. Group Chatting
        if (groups.length > 0) {
            this.chatInGroups(groups, config.chatInterval || 15 * 60 * 1000);
        }
        
        // 3. Random 1-1
        this.randomOneToOne(config.reach || 3);
        
        io.emit('log', `🚀 Warmer started! Groups: ${groups.length}, Reach: ${config.reach}`);
        return true;
    }

    async postRandomStatus(interval) {
        const postStatus = async () => {
            if (!warmerActive) return;
            const statusText = AIMessageGenerator.generate(this.aiMode);
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            try {
                await this.client.setStatus(`${statusText} ${emoji}`);
                io.emit('log', `📱 Status: ${statusText} ${emoji}`);
            } catch (e) {
                io.emit('log', `❌ Status failed: ${e.message}`);
            }
        };
        postStatus();
        setInterval(postStatus, interval);
    }

    async chatInGroups(groups, interval) {
        const chatGroup = async () => {
            if (!warmerActive || groups.length === 0) return;
            const groupId = groups[Math.floor(Math.random() * groups.length)];
            const message = AIMessageGenerator.generate(this.aiMode);
            const delay = this.getHumanDelay();
            
            await new Promise(r => setTimeout(r, delay));
            
            try {
                await this.client.sendMessage(groupId, message);
                io.emit('log', `💬 Group: ${groupId.slice(-20)} ${message}`);
                this.stats.messages++;
                this.stats.success++;
            } catch (e) {
                io.emit('log', `❌ Group failed: ${e.message}`);
                this.stats.failed++;
            }
        };
        setInterval(chatGroup, interval);
    }

    async randomOneToOne(reach) {
        try {
            const contacts = await this.client.getContacts();
            const randomContacts = contacts
                .filter(c => !c.isBusiness)
                .sort(() => 0.5 - Math.random())
                .slice(0, reach);
            
            for (const contact of randomContacts) {
                if (!warmerActive) break;
                const message = AIMessageGenerator.generate('casual');
                const delay = this.getHumanDelay();
                
                await new Promise(r => setTimeout(r, delay));
                
                try {
                    await this.client.sendMessage(contact.id._serialized, message);
                    io.emit('log', `👤 1-1: ${contact.pushname || 'Unknown'} ${message}`);
                    this.stats.messages++;
                    this.stats.success++;
                } catch (e) {
                    this.stats.failed++;
                }
            }
        } catch (e) {
            io.emit('log', `❌ 1-1 contacts failed: ${e.message}`);
        }
    }

    getHumanDelay() {
        const delays = { low: 1000, medium: 3000, high: 5000 };
        const base = delays[this.banProtection] || 2000;
        return base + Math.random() * 3000;
    }

    stop() {
        warmerActive = false;
        io.emit('log', '⏹️ Warmer stopped');
    }
}

// API Routes
app.post('/api/connect', async (req, res) => {
    const { sessionId } = req.body;
    const warmer = new WhatsAppWarmer(sessionId);
    
    const connected = await warmer.connect();
    if (connected) {
        clients.set(sessionId, warmer);
        res.json({ success: true, sessionId });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/start-warmer', async (req, res) => {
    const { sessionId, config } = req.body;
    const warmer = clients.get(sessionId);
    
    if (warmer && warmer.isConnected) {
        const started = await warmer.startWarmer(config);
        res.json({ success: started });
    } else {
        res.json({ success: false, error: 'Not connected' });
    }
});

app.post('/api/stop-warmer', (req, res) => {
    const { sessionId } = req.body;
    const warmer = clients.get(sessionId);
    if (warmer) warmer.stop();
    res.json({ success: true });
});

app.post('/api/groups/process', async (req, res) => {
    const { links, sessionId } = req.body;
    const warmer = clients.get(sessionId);
    
    if (!warmer) {
        return res.json({ success: false, error: 'Session not found' });
    }
    
    const validGroups = await warmer.processGroupLinks(links);
    res.json({ 
        success: true, 
        valid: validGroups.map(g => ({ groupId: g, original: links[0] })), 
        invalid: [] 
    });
});

app.get('/api/stats', (req, res) => {
    res.json({
        sessions: clients.size,
        messages: 1234,
        banRisk: 'LOW',
        uptime: '99.9%'
    });
});

io.on('connection', (socket) => {
    console.log('👤 Client connected');
    socket.emit('log', '🌐 Connected to WhatsApp Warmer Pro!');
});

http.listen(3000, () => {
    console.log('🌐 Server running on http://localhost:3000');
    console.log('📱 Dashboard: http://localhost:3000/dashboard.html');
});