const axios = require('axios');

const API_URL = 'http://localhost:9000';
const TOKEN = 'YOUR_ADMIN_TOKEN_HERE'; // Replace with a valid token from your login

async function testConversion() {
  try {
    console.log('--- Testing Backend Translator ---');
    
    // 1. Check Profile
    const me = await axios.get(`${API_URL}/user/me`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    console.log('Profile Balance (Cents DB, should be Birr):', me.data.available_balance);

    // 2. Check Admin User List
    const adminUsers = await axios.get(`${API_URL}/admin/users`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const testUser = adminUsers.data.users.find(u => u.number === '251900000000' || u.username === 'admin1');
    if (testUser) {
      console.log('Admin User List Balance (should be Birr):', testUser.available_balance);
    }

    console.log('--- Verification Complete ---');
  } catch (err) {
    console.error('Test failed:', err.response?.data || err.message);
  }
}

// Note: This script requires a real token. For now, we will rely on manual verification.
// testConversion();
