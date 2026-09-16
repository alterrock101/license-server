const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database ဖတ်ရန်
function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const defaultDb = {
            agents: [
                { id: 1, username: "agent_aung", pin: "1234", device_balance: 10 },
                { id: 2, username: "agent_koko", pin: "5678", device_balance: 5 }
            ],
            licenses: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2));
        return defaultDb;
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
}

// Database သိမ်းဆည်းရန်
function saveDatabase(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Key Generator Function
function generateLicenseKey(deviceId, expiryDays = 365) {
    const secret = "MY_SUPER_SECRET_KEY_2026";
    const expireTimestamp = Date.now() + (expiryDays * 24 * 60 * 60 * 1000);
    const rawData = `${deviceId.trim().toUpperCase()}|${expireTimestamp}`;

    const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        crypto.scryptSync(secret, 'salt', 32),
        Buffer.alloc(16, 0)
    );

    let encrypted = cipher.update(rawData, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return encrypted.toUpperCase();
}

// ---------------- API ROUTES ----------------

// 1. Agent Login API
app.post('/api/agent/login', (req, res) => {
    const { agentId, pin } = req.body;
    if (!agentId || !pin) {
        return res.status(400).json({ success: false, message: "Agent ID နှင့် PIN Code ဖြည့်ပါ" });
    }

    const db = loadDatabase();
    const agent = db.agents.find(a => a.id == agentId && a.pin == pin);

    if (!agent) {
        return res.status(401).json({ success: false, message: "Agent ID သို့မဟုတ် PIN Code မှားယွင်းနေပါသည်။" });
    }

    return res.json({
        success: true,
        message: "Login အောင်မြင်ပါသည်",
        agent: {
            id: agent.id,
            username: agent.username,
            device_balance: agent.device_balance
        }
    });
});

// 2. Agent မှ Key ထုတ်ပေးသော API
app.post('/api/agent/generate-key', (req, res) => {
    const { agentId, pin, deviceId, expiryDays } = req.body;

    if (!agentId || !pin || !deviceId) {
        return res.status(400).json({ success: false, message: "အချက်အလက်များ မစုံလင်ပါ။" });
    }

    const db = loadDatabase();
    const agent = db.agents.find(a => a.id == agentId && a.pin == pin);

    if (!agent) {
        return res.status(401).json({ success: false, message: "ခွင့်ပြုချက် မရှိပါ (Invalid Credentials)" });
    }

    if (agent.device_balance <= 0) {
        return res.status(400).json({ success: false, message: "သင့်တွင် ခွင့်ပြုထားသော Device အရေအတွက် ကုန်လွန်သွားပါပြီ။" });
    }

    const licenseKey = generateLicenseKey(deviceId, expiryDays || 365);
    agent.device_balance -= 1;

    db.licenses.push({
        id: db.licenses.length + 1,
        agent_id: agentId,
        device_id: deviceId,
        activation_key: licenseKey,
        created_at: new Date().toISOString()
    });

    saveDatabase(db);

    return res.json({
        success: true,
        message: "Key ထုတ်ယူမှု အောင်မြင်ပါသည်",
        deviceId: deviceId,
        licenseKey: licenseKey,
        remainingDevices: agent.device_balance
    });
});

// 3. Admin: Device Balance သတ်မှတ်ခြင်း / Agent သစ်ဖွင့်ပေးခြင်း
app.post('/api/admin/set-balance', (req, res) => {
    const { agentId, username, pin, devices } = req.body;

    if (!agentId || !devices) {
        return res.status(400).json({ success: false, message: "Agent ID နှင့် Devices အရေအတွက် ဖြည့်ရန် လိုအပ်ပါသည်။" });
    }

    const db = loadDatabase();
    let agent = db.agents.find(a => a.id == agentId);

    if (agent) {
        agent.device_balance = parseInt(devices);
        if (username) agent.username = username;
        if (pin) agent.pin = pin;
    } else {
        agent = {
            id: parseInt(agentId),
            username: username || `agent_${agentId}`,
            pin: pin || "1234",
            device_balance: parseInt(devices)
        };
        db.agents.push(agent);
    }

    saveDatabase(db);

    return res.json({
        success: true,
        message: `Agent ${agentId} အတွက် Device Quota ${devices} ခု သတ်မှတ်ပြီးပါပြီ။`,
        agent: agent
    });
});

// 4. Admin: Agent များ စာရင်း ကြည့်ရန်
app.get('/api/admin/agents', (req, res) => {
    const db = loadDatabase();
    res.json({ success: true, agents: db.agents });
});

app.listen(PORT, () => {
    console.log(`-----------------------------------------`);
    console.log(`Server running on port ${PORT}`);
    console.log(`-----------------------------------------`);
});

// ❌ Delete Agent API (Fixed with Safe Error Handling)
app.post('/api/admin/delete-agent', (req, res) => {
    try {
        const { agentId } = req.body;

        if (!agentId) {
            return res.status(400).json({ success: false, message: "Agent ID မပါဝင်ပါ။" });
        }

        let db = readDB();

        // Database ထဲတွင် Agent ID ရှိမရှိ စစ်ဆေးခြင်း
        if (!db.agents || !db.agents[agentId]) {
            return res.status(404).json({ success: false, message: "Agent ID ရှာမတွေ့ပါ။" });
        }

        // Agent ကို DB ထဲမှ ဖျက်မည်
        delete db.agents[agentId];
        writeDB(db);

        return res.json({
            success: true,
            message: `Agent ID (${agentId}) ကို အောင်မြင်စွာ ဖျက်ပြီးပါပြီ။`
        });

    } catch (error) {
        console.error("Delete Agent Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server တွင်း စာရင်းဖျက်ရာတွင် Error တက်နေပါသည်: " + error.message
        });
    }
});