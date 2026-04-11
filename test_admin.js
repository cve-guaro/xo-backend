const http = require('http');

const phone = '251961111106';
const otp = '0000';

async function run() {
  console.log('Sending OTP request...');
  const res = await fetch('http://localhost:9000/api/otp/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, code: otp, signature: 'testsig' })
  });

  const body = await res.json();
  console.log('OTP Response:', res.status, body);

  if (body.token) {
    console.log('Fetching stats using token...');
    const statsRes = await fetch('http://localhost:9000/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${body.token}` }
    });
    console.log('Stats Response:', statsRes.status);
    const statsBody = await statsRes.json();
    console.log('Stats Data Keys:', Object.keys(statsBody));

    console.log('Fetching audit logs using token...');
    const auditRes = await fetch('http://localhost:9000/api/admin/audit-logs', {
      headers: { 'Authorization': `Bearer ${body.token}` }
    });
    console.log('Audit Logs Response:', auditRes.status);
  }
}

run().catch(console.error);
