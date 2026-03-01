const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const http = require("http");

// ─── Config ───
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dhnlpvkathywzgrairyo.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRobmxwdmthdGh5d3pncmFpcnlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwMTEyNjMsImV4cCI6MjA4NzU4NzI2M30.AK7Hx29oJGdq7fO0AfKpjy2aC48IUd4DlxBcKqLiYVQ";
const APP_URL = "https://t.me/buydotmoneybot/play";
const WEB_URL = "https://www.ibuy.money/play";
const PORT = process.env.PORT || 3000;

// Your TG user ID for admin-only commands (set in Railway env)
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").filter(Boolean);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Analytics ───
async function trackEvent(event, ctx, extra = {}) {
  try {
    await supabase.from("bm_bot_analytics").insert({
      event,
      tg_user_id: ctx?.from?.id ? String(ctx.from.id) : null,
      tg_username: ctx?.from?.username || ctx?.from?.first_name || null,
      chat_id: ctx?.chat?.id ? String(ctx.chat.id) : null,
      chat_type: ctx?.chat?.type || null,
      metadata: extra,
    });
  } catch (err) {
    // Don't let analytics errors break the bot
    console.error("Analytics error:", err.message);
  }
}

// ─── In-memory group registry (synced with Supabase) ───
const activeGroups = new Set();

async function loadGroups() {
  try {
    const { data } = await supabase
      .from("bm_bot_groups")
      .select("chat_id")
      .eq("active", true);
    if (data) data.forEach((r) => activeGroups.add(String(r.chat_id)));
    console.log(`Loaded ${activeGroups.size} groups from DB`);
  } catch (err) {
    console.error("Failed to load groups:", err.message);
  }
}

async function registerGroup(chatId, title) {
  const id = String(chatId);
  if (activeGroups.has(id)) return;
  activeGroups.add(id);
  try {
    await supabase.from("bm_bot_groups").upsert(
      { chat_id: id, title: title || "Unknown", active: true, joined_at: new Date().toISOString() },
      { onConflict: "chat_id" }
    );
    console.log(`Registered group: ${title} (${id})`);
  } catch (err) {
    console.error("Failed to register group:", err.message);
  }
}

async function unregisterGroup(chatId) {
  const id = String(chatId);
  activeGroups.delete(id);
  try {
    await supabase.from("bm_bot_groups").update({ active: false }).eq("chat_id", id);
    console.log(`Unregistered group: ${id}`);
  } catch (err) {
    console.error("Failed to unregister group:", err.message);
  }
}

// ─── Auto-register when bot is added to a group ───
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  const newStatus = ctx.myChatMember?.new_chat_member?.status;
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  if (!isGroup) return;

  if (newStatus === "member" || newStatus === "administrator") {
    await registerGroup(chat.id, chat.title);
    await trackEvent("group_join", ctx, { group_title: chat.title });

    const keyboard = new InlineKeyboard().url("Play Now", APP_URL);
    try {
      await bot.api.sendMessage(
        chat.id,
        [
          "BuyMoney is now active in this group!",
          "",
          "Battle royale for your USDC.",
          "-> Deposit USDC into the pot",
          "-> Every 60 sec the smallest bag gets eliminated",
          "-> Survive 5 min and keep the pot",
          "",
          "Winner announcements will post here automatically.",
          "",
          "Type /play to jump in.",
        ].join("\n"),
        { reply_markup: keyboard }
      );
    } catch (err) {
      console.error("Failed to send intro:", err.message);
    }
  } else if (newStatus === "left" || newStatus === "kicked") {
    await unregisterGroup(chat.id);
    await trackEvent("group_leave", ctx, { group_title: chat.title });
  }
});

// ─── Also register on any group command ───
function ensureGroupRegistered(ctx) {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (isGroup) registerGroup(ctx.chat.id, ctx.chat.title);
}

// ─── /start ───
bot.command("start", async (ctx) => {
  ensureGroupRegistered(ctx);
  const startParam = ctx.match;
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // Track with referral info
  if (startParam) {
    await trackEvent("referral_start", ctx, { referral_code: startParam });
  } else {
    await trackEvent("start", ctx);
  }

  const keyboard = isGroup
    ? new InlineKeyboard()
        .url("Play Now", APP_URL)
        .row()
        .url("Share with friends", `https://t.me/share/url?url=${encodeURIComponent(APP_URL)}&text=${encodeURIComponent("Battle royale for your USDC. Deposit, survive 5 min, keep the pot. Play now:")}`)
    : new InlineKeyboard()
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
});

// ─── /play ───
bot.command("play", async (ctx) => {
  ensureGroupRegistered(ctx);
  await trackEvent("play", ctx);

  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const keyboard = isGroup
    ? new InlineKeyboard().url("Open BuyMoney", APP_URL)
    : new InlineKeyboard().webApp("Open BuyMoney", WEB_URL);

  await ctx.reply("Tap to open BuyMoney:", { reply_markup: keyboard });
});

// ─── /share ───
bot.command("share", async (ctx) => {
  ensureGroupRegistered(ctx);
  await trackEvent("share", ctx);

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
  ensureGroupRegistered(ctx);
  await trackEvent("stats", ctx);

  try {
    const { data: rounds } = await supabase
      .from("bm_rounds")
      .select("id, total_pot, player_count, state")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!rounds || rounds.length === 0) {
      return ctx.reply("No rounds played yet.");
    }

    const ended = rounds.filter((r) => r.state === "ended");
    const active = rounds.filter((r) => r.state === "active");
    const totalVolume = rounds.reduce((s, r) => s + Number(r.total_pot || 0), 0);

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
  ensureGroupRegistered(ctx);
  await ctx.reply(
    [
      "BuyMoney Commands:",
      "",
      "/play - Open the game",
      "/share - Get your referral link",
      "/stats - View game stats",
      "/help - Show this message",
    ].join("\n")
  );
});

// ─── /analytics (admin only) ───
bot.command("analytics", async (ctx) => {
  const userId = String(ctx.from?.id);

  // If ADMIN_IDS is set, restrict. Otherwise allow anyone (for testing)
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(userId)) {
    return; // Silent ignore for non-admins
  }

  await trackEvent("analytics_view", ctx);

  try {
    // Get summary stats
    const { data: summary } = await supabase
      .from("bm_bot_summary")
      .select("*")
      .single();

    // Get today's breakdown
    const today = new Date().toISOString().split("T")[0];
    const { data: todayStats } = await supabase
      .from("bm_bot_daily_stats")
      .select("*")
      .eq("day", today);

    // Get last 7 days unique users
    const { data: weekUsers } = await supabase
      .from("bm_bot_analytics")
      .select("tg_user_id")
      .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

    const weeklyUnique = new Set(weekUsers?.map((r) => r.tg_user_id).filter(Boolean)).size;

    // Get top referrers
    const { data: topRefs } = await supabase
      .from("bm_bot_analytics")
      .select("metadata")
      .eq("event", "referral_start")
      .order("created_at", { ascending: false })
      .limit(100);

    const refCounts = {};
    topRefs?.forEach((r) => {
      const code = r.metadata?.referral_code;
      if (code) refCounts[code] = (refCounts[code] || 0) + 1;
    });
    const topRefList = Object.entries(refCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Build response
    const s = summary || {};
    const lines = [
      "BuyMoney Bot Analytics",
      "═══════════════════",
      "",
      "ALL TIME:",
      `  Total users: ${s.total_users || 0}`,
      `  DAU (24h): ${s.dau || 0}`,
      `  WAU (7d): ${weeklyUnique}`,
      `  Groups: ${s.total_groups || 0} (${activeGroups.size} active)`,
      "",
      "COMMANDS:",
      `  /start: ${s.total_starts || 0}`,
      `  /play: ${s.total_plays || 0}`,
      `  /share: ${s.total_shares || 0}`,
      `  Mini app opens: ${s.total_miniapp_opens || 0}`,
      `  Referral starts: ${s.total_referral_starts || 0}`,
    ];

    if (todayStats && todayStats.length > 0) {
      lines.push("", "TODAY:");
      todayStats.forEach((row) => {
        lines.push(`  ${row.event}: ${row.count} (${row.unique_users} unique)`);
      });
    }

    if (topRefList.length > 0) {
      lines.push("", "TOP REFERRERS:");
      topRefList.forEach(([code, count]) => {
        lines.push(`  ${code}: ${count} signups`);
      });
    }

    await ctx.reply(lines.join("\n"));
  } catch (err) {
    console.error("Analytics error:", err);
    await ctx.reply("Failed to fetch analytics. Check Supabase logs.");
  }
});

// ─── Handle inline button callbacks ───
bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// ─── Win Announcement Function ───
async function announceWin(roundNumber, winnerName, winnerBag, playerCount, totalPot) {
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

  const keyboard = new InlineKeyboard().url("Play Now", APP_URL);

  // Track the win announcement
  await trackEvent("win_announced", null, {
    round_number: roundNumber,
    winner: winnerName,
    pot: totalPot,
    players: playerCount,
    groups_count: activeGroups.size,
  });

  for (const chatId of activeGroups) {
    try {
      await bot.api.sendMessage(chatId, msg, { reply_markup: keyboard });
    } catch (err) {
      console.error(`Failed to announce to ${chatId}:`, err.message);
      if (
        err.message?.includes("kicked") ||
        err.message?.includes("blocked") ||
        err.message?.includes("not a member") ||
        err.message?.includes("chat not found")
      ) {
        await unregisterGroup(chatId);
      }
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

    const { data: survivors } = await supabase
      .from("bm_entries")
      .select("wallet_address, bag")
      .eq("round_id", latest.id)
      .eq("alive", true)
      .order("bag", { ascending: false })
      .limit(1);

    if (!survivors || survivors.length === 0) return;

    const winner = survivors[0];

    const { data: player } = await supabase
      .from("bm_players")
      .select("username")
      .eq("wallet_address", winner.wallet_address)
      .single();

    const winnerName = player?.username || winner.wallet_address.slice(0, 6) + "...";

    await announceWin(latest.round_number, winnerName, winner.bag, latest.player_count, latest.total_pot);

    console.log(`Announced Round #${latest.round_number} winner: ${winnerName} to ${activeGroups.size} groups`);
  } catch (err) {
    console.error("Poll error:", err);
  }
}

// Poll every 30 seconds for new wins
setInterval(pollForWins, 30000);

// ─── Error handler ───
bot.catch((err) => {
  console.error("Bot error:", err.message || err);
});

// ─── Start ───
async function main() {
  await loadGroups();

  bot.start({
    onStart: () => {
      console.log(`BuyMoney bot is running (polling mode) — ${activeGroups.size} groups`);
      pollForWins();
    },
  });
}

main();

// Health check server for Railway (also serves analytics JSON)
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
  } else if (req.url === "/analytics.json") {
    // Quick analytics endpoint for external dashboards
    try {
      const { data } = await supabase.from("bm_bot_summary").select("*").single();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ...data, active_groups: activeGroups.size, timestamp: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(200);
    res.end(`BuyMoney bot running — ${activeGroups.size} groups`);
  }
});

server.listen(PORT, () => {
  console.log(`Health server on port ${PORT}`);
});
