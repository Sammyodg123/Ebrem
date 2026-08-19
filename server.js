require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const Pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_ID;
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP_NUMBER;

let globalSockets = {};
let pendingQR = {};
let isWaConnected = false;
let lastTelegramChatId = OWNER_CHAT_ID ? OWNER_CHAT_ID.toString() : null;

function getSessionName(n){ return `session_${n.replace(/[^0-9]/g,'')}` }

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('EBREM Bot Started...');

tgBot.onText(/\/start/, (msg) => {
  lastTelegramChatId = msg.chat.id.toString();
  tgBot.sendMessage(msg.chat.id, `🔥 EBREM Bot Live\nYour ID: ${msg.chat.id}\nSave this ID in .env as TELEGRAM_OWNER_ID\n\n/pair 234... - Link WhatsApp\n/status - Check\n/unlink - Reset`);
});

async function connectWhatsApp(number, telegramChatId) {
  const cleanNumber = number.replace(/[^0-9]/g,'');
  if(telegramChatId) lastTelegramChatId = telegramChatId.toString();
  const sessionName = getSessionName(cleanNumber);
  const authFolder = `./auth/${sessionName}`;
  let { state, saveCreds } = await useMultiFileAuthState(authFolder);

  if (!state.creds.registered && fs.existsSync(authFolder) && !state.creds.me) {
    try{ fs.rmSync(authFolder, {recursive:true, force:true}); }catch{}
    fs.mkdirSync(authFolder, {recursive:true});
    const fresh = await useMultiFileAuthState(authFolder);
    state = fresh.state; saveCreds = fresh.saveCreds;
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: Pino({level:'silent'}),
    browser: Browsers.ubuntu('Chrome'),
  });
  globalSockets[cleanNumber] = sock;

  if (!sock.authState.creds.registered) {
    await new Promise(r=>setTimeout(r,2500));
    try{
      const code = await sock.requestPairingCode(cleanNumber);
      pendingQR[cleanNumber]=code;
      console.log(`\n📱 PAIRING CODE FOR ${cleanNumber}: ${code}\n`);
      if(telegramChatId){
        await tgBot.sendMessage(telegramChatId, `📱 <b>PAIRING CODE: ${code}</b>\n\nNumber: <code>${cleanNumber}</code>\n\nGo to WhatsApp > Linked Devices > Link with phone number > Enter code: <b>${code}</b>`, {parse_mode:'HTML'});
      }
    }catch(e){
      console.log('Pair error', e.message);
      if(telegramChatId) tgBot.sendMessage(telegramChatId, `❌ Failed: ${e.message}. Do /unlink and try again.`);
    }
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u)=>{
    if(u.connection==='open'){
      isWaConnected=true;
      delete pendingQR[cleanNumber];
      console.log(`✅ WHATSAPP CONNECTED: ${cleanNumber}`);
      if(telegramChatId) tgBot.sendMessage(telegramChatId, `✅ WHATSAPP ${cleanNumber} LINKED!\nOrders will now come to Telegram + WhatsApp.`);
    }
    if(u.connection==='close'){
      isWaConnected=false;
      const status = u.lastDisconnect?.error?.output?.statusCode;
      if(status!==DisconnectReason.loggedOut){
        setTimeout(()=>connectWhatsApp(cleanNumber, null),5000);
      } else {
        if(fs.existsSync(authFolder)) fs.rmSync(authFolder, {recursive:true, force:true});
        delete globalSockets[cleanNumber];
      }
    }
  });
}

tgBot.onText(/\/pair (.+)/, async (msg, match)=>{
  const num = match[1].replace(/[^0-9]/g,'');
  lastTelegramChatId = msg.chat.id.toString();
  tgBot.sendMessage(msg.chat.id, `⏳ Generating code for ${num}...`);
  await connectWhatsApp(num, msg.chat.id);
});

tgBot.onText(/\/status/, (msg)=>{
  tgBot.sendMessage(msg.chat.id, `WA: ${isWaConnected? '✅ Connected':'❌ Not connected'}\nTelegramID: ${lastTelegramChatId}\nOwnerID: ${OWNER_CHAT_ID}\nOwnerWA: ${OWNER_WHATSAPP}\nSockets: ${Object.keys(globalSockets).join(',')||'none'}`);
});

tgBot.onText(/\/unlink/, async (msg)=>{
  for(const s of Object.values(globalSockets)){ try{ await s.logout(); }catch{} }
  if(fs.existsSync('./auth')) fs.rmSync('./auth', {recursive:true, force:true});
  globalSockets={}; pendingQR={}; isWaConnected=false;
  tgBot.sendMessage(msg.chat.id, '✅ Reset done. Do /pair 234xxx again.');
});

if(fs.existsSync('./auth')){
  for(const f of fs.readdirSync('./auth')){
    if(f.startsWith('session_')) connectWhatsApp(f.replace('session_',''), null);
  }
}

// --- THIS IS THE PART THAT SENDS TO YOUR TELEGRAM + WHATSAPP ---
app.post('/api/order', async (req,res)=>{
  const o = req.body;
  const orderId = o.orderId || '#EB-'+Math.floor(1000+Math.random()*9000);
  const itemsText = (o.items||[]).map(i=>`• ${i.name} x${i.qty||1} - ${i.price}`).join('\n');
  
  const message = `🔥 NEW EBREM ORDER ${orderId} 🔥\n\n👤 Name: ${o.name}\n📞 Phone: ${o.phone}\n📧 Email: ${o.email}\n📍 Address: ${o.address}\n${o.note? '📝 Note: '+o.note+'\n':''}🕒 ${o.date}\n\n🛒 ITEMS:\n${itemsText}\n\n💰 Total: ${o.total}\n\nReply this customer on WhatsApp: ${o.phone}`;

  console.log('NEW ORDER:', message);

  try{
    // 1. SEND TO TELEGRAM (your bot)
    const tgTarget = OWNER_CHAT_ID || lastTelegramChatId;
    if(tgTarget){
      await tgBot.sendMessage(tgTarget.toString(), message);
      console.log('✅ Sent to Telegram', tgTarget);
    }

    // 2. SEND TO WHATSAPP (to YOUR personal WhatsApp, using the paired session)
    for(const [num,sock] of Object.entries(globalSockets)){
      if(sock.authState.creds.registered){
        const dest = (OWNER_WHATSAPP ? OWNER_WHATSAPP.replace(/[^0-9]/g,'') : num) + '@s.whatsapp.net';
        try{
          await sock.sendMessage(dest, {text: message});
          console.log('✅ Sent to WhatsApp', dest);
          break;
        }catch(e){ console.log('WA send failed', e.message); }
      }
    }

    res.json({success:true, orderId});
  }catch(e){
    console.error(e);
    res.status(500).json({success:false, error:e.message});
  }
});

app.get('/', (req,res)=>res.send(`EBREM OK - WA: ${isWaConnected?'Connected':'Not Connected'}`));
app.get('/status', (req,res)=>res.json({whatsappConnected:isWaConnected, telegramId:lastTelegramChatId}));

const PORT = process.env.SERVER_PORT || process.env.PORT || 2090;
app.listen(PORT, '0.0.0.0', ()=>console.log(`Server running on 0.0.0.0:${PORT}`));
