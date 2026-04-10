import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';

const token = jwt.sign({ id: '00000000-0000-0000-0000-000000000000', role: 'admin' }, 'dev-jwt-secret-key-123456');

async function test() {
  console.log("Token:", token);
  try {
    // 1. Get users list to find an ID
    const r1 = await fetch('http://localhost:9000/admin/users?limit=5', {
      headers: { 'Authorization': `Bearer ${token}`, 'x-platform': 'web' }
    });
    const d1 = await r1.json();
    console.log("Users GET response:", r1.status, JSON.stringify(d1).slice(0, 100));

    if (d1.users && d1.users.length > 0) {
      const u = d1.users[0];
      console.log("Testing Ban on:", u.id);

      // 2. Ban user
      const r2 = await fetch(`http://localhost:9000/admin/users/${u.id}/ban`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-platform': 'web'
        },
        body: JSON.stringify({ banned: true })
      });
      console.log("Ban response:", r2.status, await r2.text());
    }

  } catch(err) {
    console.error(err);
  }
}

test();
