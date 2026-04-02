const axios = require('axios');
const { pool } = require('./src/db/index.js');
const API_URL = 'http://localhost:9000'; // Assuming this is the backend port

async function testBonus() {
  const number = '09' + Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
  console.log('Testing with number:', number);

  try {
    // 1. Request OTP
    await axios.post(`${API_URL}/auth/request-otp`, { number });
    
    // 2. Read OTP from DB
    const resDb = await pool.query(`SELECT code FROM otps WHERE number = $1 ORDER BY created_at DESC LIMIT 1`, [number]);
    if (!resDb.rows.length) {
      console.log('OTP not found in DB!');
      process.exit(1);
    }
    const code = resDb.rows[0].code;
    console.log('Intercepted OTP code:', code);

    // 3. Set setting explicitly just in case
    await pool.query(`INSERT INTO global_settings (key, value) VALUES ('welcome_bonus_active', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
    await pool.query(`INSERT INTO global_settings (key, value) VALUES ('welcome_bonus_amount', '10') ON CONFLICT (key) DO UPDATE SET value = '10'`);

    // 4. Verify OTP mimicking Web
    const verifyRes = await axios.post(`${API_URL}/auth/verify-otp`, { number, code }, {
      headers: {
        'x-platform': 'web'
      }
    });

    const token = verifyRes.data.token;
    console.log('Logged in successfully, token received.');

    // 5. Check /user/me
    const meRes = await axios.get(`${API_URL}/user/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('Profile Response:', meRes.data);

    if (meRes.data.bonus_balance === 10) {
      console.log('✅ TEST PASSED: 10 ETB Bonus was successfully applied to bonus_balance!');
    } else {
      console.log('❌ TEST FAILED: Bonus balance is', meRes.data.bonus_balance);
    }
    
    process.exit(0);
  } catch (err) {
    console.error('Error during test:', err.response?.data || err.message);
    process.exit(1);
  }
}

testBonus();
