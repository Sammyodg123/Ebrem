require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const Pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_ID;
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP_NUMBER;

let globalSockets = {};
let isWaConnected = false;
let lastTelegramChatId = OWNER_CHAT_ID? OWNER_CHAT_ID.toString() : null;

function getSessionName(n){ return `session_${n.replace(/[^0-9]/g,'')}` }

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('EBREM Bot Started...');

tgBot.onText(/\/start/, (msg) => {
  lastTelegramChatId = msg.chat.id.toString();
  tgBot.sendMessage(msg.chat.id, `🔥 EBREM Bot Live\nID: ${msg.chat.id}\n\n/pair 234... - Link WhatsApp\n/status\n/unlink`);
});

async function connectWhatsApp(number, telegramChatId, isRetry=false) {
  const cleanNumber = number.replace(/[^0-9]/g,'');
  if(telegramChatId) lastTelegramChatId = telegramChatId.toString();
  const sessionName = getSessionName(cleanNumber);
  const authFolder = `./auth/${sessionName}`;

  // FORCE CLEAN ON FIRST TRY - this fixes "Couldn't link device"
  if (!isRetry && fs.existsSync(authFolder)) {
    try{ fs.rmSync(authFolder, {recursive:true, force:true}); }catch{}
  }
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, {recursive:true});

  let { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: Pino({level:'silent'}),
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
  });

  globalSockets[cleanNumber] = sock;
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    await delay(3000);
    try{
      const code = await sock.requestPairingCode(cleanNumber);
      console.log(`\n📱 CODE FOR ${cleanNumber}: ${code}\n`);
      if(telegramChatId){
        await tgBot.sendMessage(telegramChatId, `📱 CODE: *${code}*\n\nNumber: ${cleanNumber}\n\nWhatsApp > Linked Devices > Link with phone number > Enter code\n\nCode expires in 60 sec. If it fails, do /pair again.`, {parse_mode:'Markdown'});
      }
    }catch(e){
      console.log('Pair error', e.message);
      if(telegramChatId) tgBot.sendMessage(telegramChatId, `❌ Failed: ${e.message}. Try /unlink then /pair again.`);
    }
  }

  sock.ev.on('connection.update', async (u)=>{
    if(u.connection==='open'){
      isWaConnected=true;
      console.log(`✅ CONNECTED: ${cleanNumber}`);
      if(telegramChatId) tgBot.sendMessage(telegramChatId, `✅ WHATSAPP ${cleanNumber} LINKED! Orders will now come.`);
    }
    if(u.connection==='close'){
      isWaConnected=false;
      const status = u.lastDisconnect?.error?.output?.statusCode;
      console.log('Closed, status', status);
      if(status!==DisconnectReason.loggedOut){
        setTimeout(()=>connectWhatsApp(cleanNumber, null, true), 4000);
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
  await tgBot.sendMessage(msg.chat.id, `⏳ Deleting old session and generating NEW code for ${num}...`);
  await connectWhatsApp(num, msg.chat.id, false);
});

tgBot.onText(/\/status/, (msg)=>{
  tgBot.sendMessage(msg.chat.id, `WA: ${isWaConnected? '✅ Connected':'❌ Not'}\nOwnerWA: ${OWNER_WHATSAPP}\nSockets: ${Object.keys(globalSockets).join(',')||'none'}`);
});

tgBot.onText(/\/unlink/, async (msg)=>{
  for(const s of Object.values(globalSockets)){ try{ await s.logout(); }catch{} }
  if(fs.existsSync('./auth')) fs.rmSync('./auth', {recursive:true, force:true});
  globalSockets={}; isWaConnected=false;
  tgBot.sendMessage(msg.chat.id, '✅ All sessions deleted. Now do /pair 2347066248340');
});

if(fs.existsSync('./auth')){
  for(const f of fs.readdirSync('./auth')){
    if(f.startsWith('session_')) connectWhatsApp(f.replace('session_',''), null, true);
  }
}

app.post('/api/order', async (req,res)=>{
  const o = req.body;
  const orderId = o.orderId || '#EB-'+Math.floor(1000+Math.random()*9000);
  const itemsText = (o.items||[]).map(i=>`• ${i.name} x${i.qty||1} - ${i.price}`).join('\n');
  const message = `🔥 NEW EBREM ORDER ${orderId} 🔥\n\n👤 ${o.name}\n📞 ${o.phone}\n📧 ${o.email}\n📍 ${o.address}\n${o.note? '📝 '+o.note+'\n':''}🕒 ${o.date}\n\n🛒\n${itemsText}\n\n💰 ${o.total}`;

  try{
    const tgTarget = OWNER_CHAT_ID || lastTelegramChatId;
    if(tgTarget) await tgBot.sendMessage(tgTarget.toString(), message);
    for(const [num,sock] of Object.entries(globalSockets)){
      if(sock.authState.creds.me){
        const dest = (OWNER_WHATSAPP? OWNER_WHATSAPP.replace(/[^0-9]/g,'') : num) + '@s.whatsapp.net';
        try{ await sock.sendMessage(dest, {text: message}); break; }catch(e){}
      }
    }
    res.json({success:true, orderId});
  }catch(e){
    res.status(500).json({success:false, error:e.message});
  }
});

app.get('/', (req,res)=>res.send(`EBREM OK - WA: ${isWaConnected?'Connected':'Not Connected'}`));
const PORT = process.env.PORT || 2090;
app.listen(PORT, '0.0.0.0', ()=>console.log(`Server on ${PORT}`));
