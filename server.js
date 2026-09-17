const express = require('express');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// 💡 Supabase Connection String
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres.vxfgicxykmxzgelagupj:Ar%401651973kotoe@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// CORS Config
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Key Generator Function (AES-256-CBC)
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

// ---------------- API ROUTES (Supabase PostgreSQL Integrated) ----------------

// 1. Agent Login API
app.post('/api/agent/login', async (req, res) => {
    try {
        const { agentId, pin } = req.body;
        if (!agentId || !pin) {
            return res.status(400).json({ success: false, message: "Agent ID နှင့် PIN Code ဖြည့်ပါ" });
        }

        const result = await pool.query(
            'SELECT * FROM agents WHERE id = $1 AND pin = $2',
            [agentId, pin]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Agent ID သို့မဟုတ် PIN Code မှားယွင်းနေပါသည်။" });
        }

        const agent = result.rows[0];
        return res.json({
            success: true,
            message: "Login အောင်မြင်ပါသည်",
            agent: {
                id: agent.id,
                username: agent.username,
                quota_6m: agent.quota_6m || 0,
                quota_1y: agent.quota_1y || 0
            }
        });
    } catch (error) {
        console.error("Login Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

// 2. Agent Generate License Key API
app.post('/api/agent/generate-key', async (req, res) => {
    try {
        const { agentId, pin, deviceId, planType } = req.body;

        if (!agentId || !pin || !deviceId) {
            return res.status(400).json({ success: false, message: "အချက်အလက်များ မပြည့်စုံပါ။ (Agent ID, PIN, Device ID လိုအပ်ပါသည်)" });
        }

        // Agent အကောင့်နှင့် PIN Code စစ်ဆေးခြင်း
        const agentRes = await pool.query(
            'SELECT * FROM agents WHERE id = $1 AND pin = $2',
            [agentId, pin]
        );

        if (agentRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Agent ID သို့မဟုတ် PIN မှားယွင်းနေပါသည်။" });
        }

        const agent = agentRes.rows[0];

        // 💡 Plan Type စာလုံးပေါင်း ပြဿနာ ကာကွယ်ခြင်း (1year / 1y / 6months / 6m)
        const is1Year = (planType === '1year' || planType === '1y');
        const currentQuota = is1Year ? Number(agent.quota_1y || 0) : Number(agent.quota_6m || 0);

        if (currentQuota <= 0) {
            return res.status(400).json({
                success: false,
                message: `သင့်တွင် ${is1Year ? '1 Year' : '6 Months'} Plan အတွက် ခွင့်ပြုထားသော Quota ကုန်လွန်သွားပါပြီ။ (လက်ရှိ Quota: ${currentQuota})`
            });
        }

        // License Key ထုတ်ပေးခြင်း
        const durationDays = is1Year ? 365 : 180;
        const licenseKey = generateLicenseKey(deviceId, durationDays);

        // Quota ၁ ခု လျှော့မည်
        if (is1Year) {
            await pool.query('UPDATE agents SET quota_1y = GREATEST(0, quota_1y - 1) WHERE id = $1', [agentId]);
        } else {
            await pool.query('UPDATE agents SET quota_6m = GREATEST(0, quota_6m - 1) WHERE id = $1', [agentId]);
        }

        // Supabase keys table ထဲသို့ သိမ်းမည် (Error တက်လျှင်လည်း Key ကို Return ပြန်ပေးမည်)
        try {
            await pool.query(
                'INSERT INTO keys (agent_id, device_id, plan_type, license_key, created_at) VALUES ($1, $2, $3, $4, NOW())',
                [agentId, deviceId, is1Year ? '1year' : '6months', licenseKey]
            );
        } catch (dbErr) {
            console.error("Keys Table Insert Error (Non-fatal):", dbErr.message);
        }

        const remainingQuota = currentQuota - 1;

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

// 3. Admin: Set Agent Quota
app.post('/api/admin/set-balance', async (req, res) => {
    try {
        const { agentId, username, pin, planType, devices } = req.body;

        const agentRes = await pool.query('SELECT * FROM agents WHERE id = $1', [agentId]);

        if (agentRes.rows.length === 0) {
            const q6m = (planType === '6months' || planType === '6m') ? Number(devices) : 0;
            const q1y = (planType === '1year' || planType === '1y') ? Number(devices) : 0;
            await pool.query(
                'INSERT INTO agents (id, username, pin, quota_6m, quota_1y) VALUES ($1, $2, $3, $4, $5)',
                [agentId, username || `agent_${agentId}`, pin || "1234", q6m, q1y]
            );
        } else {
            if (username) await pool.query('UPDATE agents SET username = $1 WHERE id = $2', [username, agentId]);
            if (pin) await pool.query('UPDATE agents SET pin = $1 WHERE id = $2', [pin, agentId]);

            if (planType === '6months' || planType === '6m') {
                await pool.query('UPDATE agents SET quota_6m = COALESCE(quota_6m, 0) + $1 WHERE id = $2', [Number(devices), agentId]);
            } else if (planType === '1year' || planType === '1y') {
                await pool.query('UPDATE agents SET quota_1y = COALESCE(quota_1y, 0) + $1 WHERE id = $2', [Number(devices), agentId]);
            }
        }

        return res.json({
            success: true,
            message: `Agent ID (${agentId}) သို့ Quota (${devices}) ခု ဖြည့်သွင်းပြီးပါပြီ။`
        });

    } catch (error) {
        console.error("Set Balance Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

// 4. Admin: Agent များ စာရင်း ကြည့်ရန်
app.get('/api/admin/agents', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM agents ORDER BY id ASC');
        res.json({ success: true, agents: result.rows });
    } catch (error) {
        console.error("Fetch Agents Error:", error);
        res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

// 5. Admin: Delete Agent API
app.post('/api/admin/delete-agent', async (req, res) => {
    try {
        const { agentId } = req.body;
        const result = await pool.query('DELETE FROM agents WHERE id = $1 RETURNING *', [agentId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Agent ID ရှာမတွေ့ပါ။" });
        }

        return res.json({ success: true, message: `Agent ID (${agentId}) ကို အပြီးတိုင် ဖျက်ပြီးပါပြီ။` });
    } catch (error) {
        console.error("Delete Agent Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`-----------------------------------------`);
    console.log(`Server running on port ${PORT}`);
    console.log(`-----------------------------------------`);
});