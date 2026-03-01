const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const http = require("http");

// ─── Config ───
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dhnlpvkathywzgrairyo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // use service key for listening to DB changes
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRobmxwdmthdGh5d3pncmFpcnlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwMTEyNjMsImV4cCI6MjA4NzU4NzI2M30.AK7Hx29oJGdq7fO0AfKpjy2aC48IUd4DlxBcKqLiYVQ";
const APP_URL = "https://t.me/buydotmoneybot/play";
const WEB_URL = "https://www.ibuy.money/play";
const PORT = process.env.PORT || 3000;

// Channels/groups to post win announcements (add chat IDs here)
const ANNOUNCE_CHATS = (process.env.ANNOUNCE_CHATS || "").split(",").filter(Boolean);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── /start ───
bot.command("start", async (ctx) => {
  const startParam = ctx.match; // referral code from deep link

  const keyboard = new InlineKeyboard()
    .webApp("Play Now", WEB_URL)
    .row()
    .url("Share with friends", `https://t.me/share/url?url=${encodeURIComponent(APP_URL)}&text=${encodeURIComponent("Battle royale for your USDC. Deposit, survive 5 min, keep the pot. Play now:")}`);

  const welcome = [
    "Welcome to BuyMoney",
    "",
    "Battle royale for your USDC.",
    "",
    "How it works:",
    "-> Deposit USDC into the pot",
    "-> Every 60 sec the smallest bag gets eliminated",
    "-> Survive 5 min and keep your bag + eliminated players money",
    "",
    "Tap Play Now to start.",
  ].join("\n");

  await ctx.reply(welcome, { reply_markup: keyboard });

  // If they came via referral link, log it
  if (startParam) {
    console.log(`User ${ctx.from?.id} started with referral: ${startParam}`);
  }
});

// ─── /play ───
bot.command("play", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .webApp("Open BuyMoney", WEB_URL);

  await ctx.reply("Tap to open BuyMoney:", { reply_markup: keyboard });
});

// ─── /share ───
bot.command("share", async (ctx) => {
  // Generate a referral link using the user's TG id as ref code
  const refCode = `TG${ctx.from?.id}`;
  const shareUrl = `${APP_URL}?startapp=${refCode}`;
  const shareText = `I'm playing BuyMoney - battle royale for USDC. Deposit, survive, keep the pot. Join me:`;

  const keyboard = new InlineKeyboard()
    .url("Share your link", `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`);

  await ctx.reply(
    `Your referral link:\n${shareUrl}\n\nShare it and earn a cut of every buy-in from players you refer.`,
    { reply_markup: keyboard }
  );
});

// ─── /stats ───
bot.command("stats", async (ctx) => {
  try {
    const { data: rounds } = await supabase
      .from("bm_rounds")
      .select("id, total_pot, player_count, state")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!rounds || rounds.length === 0) {
      return ctx.reply("No rounds played yet.");
    }

    const ended = rounds.filter(r => r.state === "ended");
    const active = rounds.filter(r => r.state === "active");
    const totalVolume = rounds.reduce((s, r) => s + Number(r.total_pot || 0), 0);
    const totalPlayers = new Set(rounds.map(r => r.player_count)).size;

    const stats = [
      "BuyMoney Stats",
      "",
      `Rounds played: ${ended.length}`,
      `Live rounds: ${active.length}`,
      `Total volume: $${totalVolume.toFixed(2)} USDC`,
      "",
      "Tap /play to jump in.",
    ].join("\n");

    await ctx.reply(stats);
  } catch (err) {
    console.error("Stats error:", err);
    await ctx.reply("Couldn't fetch stats right now. Try /play instead.");
  }
});

// ─── /help ───
bot.command("help", async (ctx) => {
  await ctx.reply([
    "BuyMoney Commands:",
    "",
    "/play - Open the game",
    "/share - Get your referral link",
    "/stats - View game stats",
    "/help - Show this message",
  ].join("\n"));
});

// ─── Handle inline button callbacks ───
bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// ─── Win Announcement Function ───
async function announceWin(roundNumber, winnerName, winnerBag, playerCount, totalPot) {
  const profit = (winnerBag - (totalPot / playerCount)).toFixed(2);
  const msg = [
    `Round #${roundNumber} is over!`,
    "",
    `Winner: ${winnerName}`,
    `Took home: $${Number(winnerBag).toFixed(2)} USDC`,
    `Players: ${playerCount}`,
    `Total pot: $${Number(totalPot).toFixed(2)}`,
    "",
    "Think you can survive? Tap below.",
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .webApp("Play Now", WEB_URL);

  for (const chatId of ANNOUNCE_CHATS) {
    try {
      await bot.api.sendMessage(chatId, msg, { reply_markup: keyboard });
    } catch (err) {
      console.error(`Failed to announce to ${chatId}:`, err.message);
    }
  }
}

// ─── Poll for completed rounds ───
let lastCheckedRoundId = null;

async function pollForWins() {
  try {
    const { data: rounds } = await supabase
      .from("bm_rounds")
      .select("*")
      .eq("state", "ended")
      .order("end_time", { ascending: false })
      .limit(1);

    if (!rounds || rounds.length === 0) return;

    const latest = rounds[0];
    if (latest.id === lastCheckedRoundId) return;
    lastCheckedRoundId = latest.id;

    // Find the winner (alive entry with highest bag)
    const { data: survivors } = await supabase
      .from("bm_entries")
      .select("wallet_address, bag")
      .eq("round_id", latest.id)
      .eq("alive", true)
      .order("bag", { ascending: false })
      .limit(1);

    if (!survivors || survivors.length === 0) return;

    const winner = survivors[0];

    // Get winner's username
    const { data: player } = await supabase
      .from("bm_players")
      .select("username")
      .eq("wallet_address", winner.wallet_address)
      .single();

    const winnerName = player?.username || winner.wallet_address.slice(0, 6) + "...";

    await announceWin(
      latest.round_number,
      winnerName,
      winner.bag,
      latest.player_count,
      latest.total_pot
    );

    console.log(`Announced Round #${latest.round_number} winner: ${winnerName}`);
  } catch (err) {
    console.error("Poll error:", err);
  }
}

// Poll every 30 seconds for new wins
setInterval(pollForWins, 30000);

// ─── Start ───
bot.start({
  onStart: () => {
    console.log("BuyMoney bot is running (polling mode)");
    // Initial poll
    pollForWins();
  },
});

// Health check server for Railway
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
  } else {
    res.writeHead(200);
    res.end("BuyMoney bot running");
  }
});

server.listen(PORT, () => {
  console.log(`Health server on port ${PORT}`);
});
