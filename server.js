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

// 🔑 Agent Generate License Key API (Fixed Quota Checking Bug)
app.post('/api/agent/generate-key', (req, res) => {
    try {
        const { agentId, pin, deviceId, planType } = req.body;
        let db = loadDatabase();

        // Agent အကောင့်နှင့် PIN Code စစ်ဆေးခြင်း
        const agent = db.agents.find(a => String(a.id) === String(agentId) && String(a.pin) === String(pin));
        if (!agent) {
            return res.status(401).json({ success: false, message: "Agent ID သို့မဟုတ် PIN မှားယွင်းနေပါသည်။" });
        }

        // ရွေးချယ်ထားသော Plan (6months သို့မဟုတ် 1year) အလိုက် Quota စစ်ဆေးခြင်း
        const is1Year = (planType === '1year');
        const currentQuota = is1Year ? (agent.quota_1y || 0) : (agent.quota_6m || 0);

        // Quota မရှိပါက သက်ဆိုင်ရာ Plan အတွက်သာ Error ပြမည် (အခြား Plan Quota ကို မထိခိုက်ပါ)
        if (currentQuota <= 0) {
            return res.status(400).json({
                success: false,
                message: `သင့်တွင် ${is1Year ? '1 Year' : '6 Months'} Plan အတွက် ခွင့်ပြုထားသော Device အရေအတွက် ကုန်လွန်သွားပါပြီ။`
            });
        }

        // ရွေးချယ်ထားသော Plan မှ Quota ၁ ခု သာ လျှော့မည်
        if (is1Year) {
            agent.quota_1y -= 1;
        } else {
            agent.quota_6m -= 1;
        }

        // License Key ထုတ်ပေးခြင်း (6 Months = 180 ရက်၊ 1 Year = 365 ရက်)
        const durationDays = is1Year ? 365 : 180;

        // 💡 သင့် server.js ထဲရှိ Key generate လုပ်သည့် function ကို ခေါ်သုံးပါ
        const licenseKey = typeof generateCryptoKey === 'function'
            ? generateCryptoKey(deviceId, durationDays)
            : `KEY-${planType.toUpperCase()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

        // Database ထဲသို့ ပြန်သိမ်းမည်
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

        // ကျန်ရှိသော Quota ကို ပြန်လည် ပေးပို့မည်
        const remainingQuota = is1Year ? agent.quota_1y : agent.quota_6m;

        return res.json({
            success: true,
            licenseKey: licenseKey,
            deviceId: deviceId,
            remainingQuota: remainingQuota,
            message: `${is1Year ? '1 Year' : '6 Months'} Plan License Key အောင်မြင်စွာ ထုတ်ပေးပြီးပါပြီ။`
        });

    } catch (error) {
        console.error("Generate Key Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

// 💳 Set Agent Quota (6 Months / 1 Year)
app.post('/api/admin/set-balance', (req, res) => {
    try {
        const { agentId, username, pin, planType, devices } = req.body;
        let db = loadDatabase();

        let agent = db.agents.find(a => String(a.id) === String(agentId));

        if (!agent) {
            // Agent သစ် ဆောက်မည်
            agent = {
                id: Number(agentId),
                username: username || `agent_${agentId}`,
                pin: pin || "1234",
                quota_6m: 0,
                quota_1y: 0
            };
            db.agents.push(agent);
        } else {
            if (username) agent.username = username;
            if (pin) agent.pin = pin;
        }

        // Quota ပေါင်းထည့်မည်
        if (planType === '6months') {
            agent.quota_6m = (agent.quota_6m || 0) + Number(devices);
        } else if (planType === '1year') {
            agent.quota_1y = (agent.quota_1y || 0) + Number(devices);
        }

        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

        return res.json({
            success: true,
            message: `Agent ID (${agentId}) သို့ ${planType === '6months' ? '6 လ' : '1 နှစ်'} သက်တမ်း Quota (${devices}) ခု ဖြည့်သွင်းပြီးပါပြီ။`
        });

    } catch (error) {
        console.error("Set Balance Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
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

// 🗑️ Delete Agent API (File Sync ပါဝင်ပြီးသား)
app.post('/api/admin/delete-agent', (req, res) => {
    try {
        const { agentId } = req.body;
        let db = loadDatabase();

        const initialLength = db.agents.length;
        // String မတူညီသည်များကိုသာ ချန်လှပ်၍ Filter လုပ်မည်
        db.agents = db.agents.filter(a => String(a.id) !== String(agentId));

        if (db.agents.length === initialLength) {
            return res.status(404).json({ success: false, message: "Agent ID ရှာမတွေ့ပါ။" });
        }

        // Database (JSON File) ထဲသို့ ချက်ချင်း အပြီးတိုင် ရေးသွင်းမည်
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

        return res.json({ success: true, message: `Agent ID (${agentId}) ကို အပြီးတိုင် ဖျက်ပြီးပါပြီ။` });
    } catch (error) {
        console.error("Delete Agent Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});