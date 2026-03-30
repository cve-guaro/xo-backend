const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require("body-parser"); 
const cors = require('cors');
require('dotenv').config();
const txRoutes = require("./routes/transactions");
const { recordAndProcessWebhook } = require("./models/Transaction");
const payments = require('./routes/payment');
const userRoutes = require('./routes/user');
const accountRoutes = require('./routes/account');
const otpAuthRoutes = require('./routes/otp');
const adminRoutes = require('./routes/admin');

const authRoutes = require('./routes/auth');
const { setupGameSocket } = require('./socket/game');


const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" }
});

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use('/payments', payments);
// Health
app.get('/health', (_, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use("/api/transactions", txRoutes);
app.use("/webhook/:provider", bodyParser.raw({ type: "*/*" }));
app.use('/user', userRoutes);
app.use('/auth', otpAuthRoutes);
app.use("/account", accountRoutes);
app.use('/admin', adminRoutes);

// app.post("/webhook/:provider", async (req, res) => {
//   try {
//     const providerCode = req.params.provider;
//     const rawBody = req.body; // Buffer
//     const payload = rawBody
//     console.log("Received webhook:", providerCode, payload);

//     // Map the provider payload → internal fields
//     const mapPayload = (p) => ({
//       providerEventId: p.id || p.eventId,
//       eventType: p.type,
//       providerExtId: p.data?.reference || 'test_id',
//       newStatus: mapProviderStatus(p.data?.status),
//       metadata: { raw: p },
//     });
//     console.log("Mapped webhook payload:");

//     function mapProviderStatus(s) {
//       switch (String(s || "").toLowerCase()) {
//         case "pending":
//         case "processing": return "pending";
//         case "authorized": return "authorized";
//         case "success":
//         case "succeeded":
//         case "paid":       return "succeeded";
//         case "failed":
//         case "error":      return "failed";
//         case "canceled":
//         case "cancelled":  return "canceled";
//         case "refunded":   return "refunded";
//         default:           return null;
//       }
//     }

//     const result = await recordAndProcessWebhook({
//       providerCode,
//       rawBody,
//       headers: req.headers,
//       payload,
//       mapPayload,
//       signatureHeaderName: "x-signature", // change per provider
//     });

//     res.status(200).json({ ok: true, result });
//   } catch (err) {
//     res.status(400).json({ ok: false, error: err.message });
//   }
// });

setupGameSocket(io);

const PORT = process.env.PORT || 9000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));