const jwt = require("jsonwebtoken");
const token = jwt.sign({ sub: 'user_123', role: 'superadmin', username: 'tester', phone_number: '0961111106' }, "supersecret"); // Assuming default JWT secret for testing

(async () => {
  try {
    const res = await fetch("http://localhost:2000/admin/settings", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        mobile_app_lockout: true,
        system_emergency_lockout: false
      })
    });
    
    const text = await res.text();
    console.log("PATCH status:", res.status);
    console.log("PATCH response:", text);

    const getRes = await fetch("http://localhost:2000/admin/settings", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    console.log("GET response:", await getRes.text());
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
