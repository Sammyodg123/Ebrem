require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_ID;
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP_NUMBER;

let waSocket = null;
let isWaConnected = false;
let pairingInProgress = false;

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('Telegram bot polling...');

tgBot.onText(/\/start/, (msg) => {
  tgBot.sendMessage(msg.chat.id, `🔥 EBREM Bot Live\n\nCommands:\n/pair 2349119159094 - Link WhatsApp as device\n/status - Check WhatsApp link status\n/unlink - Unlink WhatsApp device`);
});

tgBot.onText(/\/status/, async (msg) => {
  const status = isWaConnected? '✅ WhatsApp Connected as linked device' : '❌ WhatsApp NOT connected. Use /pair 234...';
  tgBot.sendMessage(msg.chat.id, status);
});

tgBot.onText(/\/unlink/, async (msg) => {
  if(OWNER_CHAT_ID && msg.chat.id.toString()!== OWNER_CHAT_ID){
    return tgBot.sendMessage(msg.chat.id, 'Not authorized');
  }
  try {
    if(waSocket){
      await waSocket.logout();
    }
    if(fs.existsSync('./auth')){
      fs.rmSync('./auth', { recursive: true, force: true });
    }
    isWaConnected = false;
    tgBot.sendMessage(msg.chat.id, '✅ Unlinked. Now use /pair again.');
    startWhatsApp();
  } catch(e){
    tgBot.sendMessage(msg.chat.id, 'Error: ' + e.message);
  }
});

tgBot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if(OWNER_CHAT_ID && chatId.toString()!== OWNER_CHAT_ID){
    return tgBot.sendMessage(chatId, '❌ You are not authorized to pair.');
  }
  if(pairingInProgress){
    return tgBot.sendMessage(chatId, '⏳ Already generating a code, wait...');
  }
  const phoneNumber = match[1].replace(/[^0-9]/g, '');
  if(phoneNumber.length < 10){
    return tgBot.sendMessage(chatId, 'Send like: /pair 2349119159094');
  }
  if(isWaConnected){
    return tgBot.sendMessage(chatId, '✅ WhatsApp is already linked! Use /unlink first if you want to link a different number.');
  }
  pairingInProgress = true;
  tgBot.sendMessage(chatId, `⏳ Generating pairing code for ${phoneNumber}...\nPlease wait 3-5 seconds.`);
  try {
    await startWhatsApp(phoneNumber, chatId);
  } catch (e) {
    console.error('Pair error:', e);
    tgBot.sendMessage(chatId, `❌ Failed to generate code: ${e.message}`);
    pairingInProgress = false;
  }
});

async function startWhatsApp(phoneForPairing = null, tgChatIdForPairing = null){
  if(waSocket){
    try { waSocket.ev.removeAllListeners(); waSocket.end(); } catch {}
    waSocket = null;
  }
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  waSocket = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }).child({ level: 'silent' })),
    },
    browser: ['EBREM', 'Chrome', '1.0.0']
  });
  waSocket.ev.on('creds.update', saveCreds);

  if(phoneForPairing &&!state.creds.registered){
    await new Promise(r => setTimeout(r, 2500));
    try {
      console.log(`Requesting pairing code for ${phoneForPairing}...`);
      const code = await waSocket.requestPairingCode(phoneForPairing);
      console.log(`\nPAIRING CODE FOR +${phoneForPairing}: ${code}\n`);
      if(tgChatIdForPairing){
        tgBot.sendMessage(tgChatIdForPairing,
`✅ YOUR PAIRING CODE:

*${code}*

Go to WhatsApp now:
1. Open WhatsApp on your phone
2. Settings > Linked Devices
3. Tap "Link a Device"
4. At bottom, tap "Link with phone number instead"
5. Enter this code: ${code}

You have 60 seconds before it expires. If it expires, run /pair ${phoneForPairing} again.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      console.error('requestPairingCode error:', e);
      if(tgChatIdForPairing){
        tgBot.sendMessage(tgChatIdForPairing, `❌ Failed: ${e.message}\n\n1. Make sure number is with country code e.g 234...\n2. You don't have too many linked devices (max 4)\n3. Try /unlink then /pair again`);
      }
    } finally {
      pairingInProgress = false;
    }
  } else {
    if(phoneForPairing && state.creds.registered){
      if(tgChatIdForPairing){
        tgBot.sendMessage(tgChatIdForPairing, '⚠️ This server is already registered. Use /unlink first.');
      }
      pairingInProgress = false;
    }
  }

  waSocket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if(connection === 'close'){
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode!== DisconnectReason.loggedOut;
      console.log('WhatsApp connection closed, code:', statusCode, 'reconnect:', shouldReconnect);
      isWaConnected = false;
      if(shouldReconnect){
        startWhatsApp();
      } else {
        console.log('Logged out, deleting auth...');
        if(fs.existsSync('./auth')){
          fs.rmSync('./auth', { recursive: true, force: true });
        }
      }
    } else if(connection === 'open'){
      console.log('✅ WhatsApp linked as device!');
      isWaConnected = true;
      pairingInProgress = false;
      if(OWNER_CHAT_ID){
        tgBot.sendMessage(OWNER_CHAT_ID, '✅ WhatsApp successfully linked as device! Now orders will come to both Telegram and your WhatsApp.');
      }
    }
  });
  return waSocket;
}

startWhatsApp();

app.post('/api/order', async (req, res) => {
  const o = req.body;
  const orderId = o.orderId || '#EB-' + Math.floor(1000+Math.random()*9000);
  const itemsText = (o.items || []).map(i => `• ${i.name} x${i.qty||1} - ${i.price}`).join('\n');
  const fullMessage = `🔥 NEW EBREM ORDER ${orderId} 🔥\n\n👤 Name: ${o.name}\n📞 Phone: ${o.phone}\n📧 Email: ${o.email}\n📍 Address: ${o.address}\n${o.note? '📝 Note: ' + o.note : ''}\n🕒 ${o.date || new Date().toLocaleString()}\n\n🛒 ITEMS:\n${itemsText}\n\n💰 Total: ${o.total}`.trim();
  try {
    if(OWNER_CHAT_ID){
      await tgBot.sendMessage(OWNER_CHAT_ID, fullMessage);
    }
    if(isWaConnected && waSocket && OWNER_WHATSAPP){
      const jid = OWNER_WHATSAPP.includes('@s.whatsapp.net')? OWNER_WHATSAPP : OWNER_WHATSAPP + '@s.whatsapp.net';
      await waSocket.sendMessage(jid, { text: fullMessage });
    }
    res.json({ success: true, orderId, whatsappLinked: isWaConnected });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req,res) => res.send(`EBREM Backend Running. WhatsApp: ${isWaConnected? 'Connected ✅' : 'Not Connected ❌ - Use /pair on Telegram'}`));
app.get('/status', (req,res) => res.json({ whatsappConnected: isWaConnected }));

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on 0.0.0.0:${PORT}`));
