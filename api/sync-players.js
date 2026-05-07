const { createClient } = require('@supabase/supabase-js')
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
 
const NFL_POSITIONS    = ['QB', 'RB', 'WR', 'TE', 'K']
const MLB_POSITIONS    = ['C', '1B', '2B', '3B', 'SS', 'OF', 'SP', 'RP']
const INJURED_STATUSES = ['Out', 'IR', 'IL', 'PUP', '60-Day IL', 'NFI', 'Suspended']
 
// ─── RANKING ENGINE (inlined) ──────────────────────────
// ═══════════════════════════════════════════════════════
// DiamondUT Ranking Engine v2
// api/ranking-engine.js
//
// Proprietary ranking algorithm — 100% DiamondUT IP
//
// DiamondUT Score = 
//   Season Stats (40%) + Recent Form (40%) + Matchup (20%)
//
// Supports:
//   NFL — Standard, Half PPR, Full PPR, Custom
//   MLB — Full scoring with all categories
//   Milestone bonuses — 40yd TD, 150yd games, 350yd pass
//   Kicker — distance-based FG scoring
//   Defense — full DEF/ST scoring
// Never needs manual updates — fully dynamic year detection
// ═══════════════════════════════════════════════════════
 
// ─── NFL SCORING PRESETS ───────────────────────────────
const NFL_SCORING = {
  standard: {
    // Passing
    pass_td: 4, pass_yd: 0.04, pass_int: -2, pass_2pt: 2,
    pass_350_bonus: 3,       // 350+ yard passing game bonus
    pass_40_td_bonus: 0,     // optional long TD bonus (off by default)
 
    // Rushing
    rush_td: 6, rush_yd: 0.1, rush_2pt: 2,
    rush_150_bonus: 3,       // 150+ yard rushing game bonus
    rush_40_td_bonus: 0,     // optional long TD bonus
 
    // Receiving
    rec_td: 6, rec_yd: 0.1, rec: 0, rec_2pt: 2,
    rec_150_bonus: 3,        // 150+ yard receiving game bonus
    rec_40_td_bonus: 0,      // optional long TD bonus
    rec_40_yd_bonus: 0,      // 40+ yard catch bonus (off by default)
 
    // Misc
    fum_lost: -2,
    fum_rec_td: 6,
 
    // Kicker
    fg_0_39: 3,              // FG made 0-39 yards
    fg_40_49: 4,             // FG made 40-49 yards
    fg_50_59: 5,             // FG made 50-59 yards
    fg_60_plus: 6,           // FG made 60+ yards
    fg_miss: -1,             // FG missed
    pat_made: 1,             // PAT/extra point made
    pat_miss: -1,            // PAT missed
 
    // Defense / Special Teams
    def_sack: 1,
    def_int: 2,
    def_fum_rec: 2,
    def_safety: 2,
    def_td: 6,
    def_blocked_kick: 2,
    def_pts_allowed_0: 10,   // shutout
    def_pts_allowed_1_6: 7,
    def_pts_allowed_7_13: 4,
    def_pts_allowed_14_20: 1,
    def_pts_allowed_21_27: 0,
    def_pts_allowed_28_34: -1,
    def_pts_allowed_35_plus: -4,
    def_yds_allowed_0_99: 5,
    def_yds_allowed_100_199: 3,
    def_yds_allowed_200_299: 2,
    def_yds_allowed_300_349: 0,
    def_yds_allowed_350_399: -1,
    def_yds_allowed_400_449: -3,
    def_yds_allowed_450_499: -5,
    def_yds_allowed_500_plus: -7,
  },
 
  half_ppr: {
    pass_td: 4, pass_yd: 0.04, pass_int: -2, pass_2pt: 2,
    pass_350_bonus: 3,
    pass_40_td_bonus: 0,
    rush_td: 6, rush_yd: 0.1, rush_2pt: 2,
    rush_150_bonus: 3,
    rush_40_td_bonus: 0,
    rec_td: 6, rec_yd: 0.1, rec: 0.5, rec_2pt: 2,
    rec_150_bonus: 3,
    rec_40_td_bonus: 0,
    rec_40_yd_bonus: 0,
    fum_lost: -2, fum_rec_td: 6,
    fg_0_39: 3, fg_40_49: 4, fg_50_59: 5, fg_60_plus: 6,
    fg_miss: -1, pat_made: 1, pat_miss: -1,
    def_sack: 1, def_int: 2, def_fum_rec: 2, def_safety: 2,
    def_td: 6, def_blocked_kick: 2,
    def_pts_allowed_0: 10, def_pts_allowed_1_6: 7,
    def_pts_allowed_7_13: 4, def_pts_allowed_14_20: 1,
    def_pts_allowed_21_27: 0, def_pts_allowed_28_34: -1,
    def_pts_allowed_35_plus: -4,
    def_yds_allowed_0_99: 5, def_yds_allowed_100_199: 3,
    def_yds_allowed_200_299: 2, def_yds_allowed_300_349: 0,
    def_yds_allowed_350_399: -1, def_yds_allowed_400_449: -3,
    def_yds_allowed_450_499: -5, def_yds_allowed_500_plus: -7,
  },
 
  full_ppr: {
    pass_td: 4, pass_yd: 0.04, pass_int: -2, pass_2pt: 2,
    pass_350_bonus: 3,
    pass_40_td_bonus: 0,
    rush_td: 6, rush_yd: 0.1, rush_2pt: 2,
    rush_150_bonus: 3,
    rush_40_td_bonus: 0,
    rec_td: 6, rec_yd: 0.1, rec: 1, rec_2pt: 2,
    rec_150_bonus: 3,
    rec_40_td_bonus: 0,
    rec_40_yd_bonus: 0,
    fum_lost: -2, fum_rec_td: 6,
    fg_0_39: 3, fg_40_49: 4, fg_50_59: 5, fg_60_plus: 6,
    fg_miss: -1, pat_made: 1, pat_miss: -1,
    def_sack: 1, def_int: 2, def_fum_rec: 2, def_safety: 2,
    def_td: 6, def_blocked_kick: 2,
    def_pts_allowed_0: 10, def_pts_allowed_1_6: 7,
    def_pts_allowed_7_13: 4, def_pts_allowed_14_20: 1,
    def_pts_allowed_21_27: 0, def_pts_allowed_28_34: -1,
    def_pts_allowed_35_plus: -4,
    def_yds_allowed_0_99: 5, def_yds_allowed_100_199: 3,
    def_yds_allowed_200_299: 2, def_yds_allowed_300_349: 0,
    def_yds_allowed_350_399: -1, def_yds_allowed_400_449: -3,
    def_yds_allowed_450_499: -5, def_yds_allowed_500_plus: -7,
  }
}
 
// ─── MLB SCORING DEFAULT ───────────────────────────────
const MLB_SCORING_DEFAULT = {
  // Batting
  single: 1,
  double: 2,
  triple: 3,
  hr: 4,
  rbi: 1,
  r: 1,
  bb: 1,
  sb: 2,
  hbp: 1,
  so: -1,               // strikeout (batter)
  cs: -1,               // caught stealing
  gdp: 0,               // ground into double play (optional, off by default)
 
  // Batting milestones
  cycle_bonus: 5,       // hitting for the cycle
 
  // Pitching
  win: 5,
  ip: 1,                // per inning pitched
  ks: 1,                // strikeout (pitcher)
  er: -1,               // earned run
  bb_allowed: -0.5,     // walk allowed
  sv: 5,                // save
  blown_save: -3,       // blown save
  hold: 2,              // hold
  quality_start: 3,     // 6+ IP, 3 or fewer ER
 
  // Pitching milestones
  complete_game: 2.5,   // complete game
  cg_shutout: 5,        // complete game shutout
  no_hitter: 10,        // no hitter (includes perfect game)
  perfect_game: 15,     // perfect game
}
 
// ─── TIER THRESHOLDS ───────────────────────────────────
const NFL_TIER_THRESHOLDS = {
  QB:  { legendary: 2,  platinum: 8,  gold: 18, silver: 32 },
  RB:  { legendary: 3,  platinum: 12, gold: 28, silver: 45 },
  WR:  { legendary: 3,  platinum: 12, gold: 30, silver: 50 },
  TE:  { legendary: 2,  platinum: 8,  gold: 18, silver: 30 },
  K:   { legendary: 2,  platinum: 8,  gold: 18, silver: 28 },
  DEF: { legendary: 2,  platinum: 8,  gold: 18, silver: 28 }
}
 
const MLB_TIER_THRESHOLDS = {
  C:    { legendary: 2, platinum: 8,  gold: 18, silver: 35 },
  '1B': { legendary: 2, platinum: 8,  gold: 18, silver: 35 },
  '2B': { legendary: 2, platinum: 8,  gold: 18, silver: 35 },
  '3B': { legendary: 2, platinum: 8,  gold: 18, silver: 35 },
  SS:   { legendary: 2, platinum: 8,  gold: 18, silver: 35 },
  OF:   { legendary: 4, platinum: 18, gold: 45, silver: 80 },
  SP:   { legendary: 3, platinum: 12, gold: 30, silver: 55 },
  RP:   { legendary: 3, platinum: 12, gold: 30, silver: 55 }
}
 
const TIER_VALUES = {
  legendary: 200, platinum: 100, gold: 60, silver: 25, bronze: 10
}
 
// ─── DYNAMIC SEASON DETECTION ──────────────────────────
function getCurrentSeasons() {
  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1
 
  // NFL: Sept-Feb. Jan/Feb = previous year's season
  const nflSeason    = (month <= 2) ? year - 1 : year
  const nflInSeason  = month >= 9 || month <= 1
 
  // MLB: April-October
  const mlbSeason    = year
  const mlbInSeason  = month >= 4 && month <= 10
 
  const nflWeek = getNFLWeek(nflSeason)
  const mlbWeek = getMLBWeek(mlbSeason)
 
  return { nflSeason, mlbSeason, nflInSeason, mlbInSeason, nflWeek, mlbWeek }
}
 
function getNFLWeek(season) {
  const now = new Date()
  const septFirst = new Date(season, 8, 1)
  const dayOfWeek = septFirst.getDay()
  const daysToThursday = (4 - dayOfWeek + 7) % 7
  const seasonStart = new Date(season, 8, 1 + daysToThursday)
  const msPerWeek = 7 * 24 * 60 * 60 * 1000
  const week = Math.floor((now - seasonStart) / msPerWeek) + 1
  return Math.max(1, Math.min(week, 18))
}
 
function getMLBWeek(season) {
  const now = new Date()
  const seasonStart = new Date(season, 2, 28)
  const msPerWeek = 7 * 24 * 60 * 60 * 1000
  const week = Math.floor((now - seasonStart) / msPerWeek) + 1
  return Math.max(1, Math.min(week, 26))
}
 
// ─── NFL SCORE CALCULATOR ──────────────────────────────
function calcNFLScore(stats, scoring) {
  if (!stats) return 0
  const s = scoring
 
  // ── Passing ──
  let pts = 0
  pts += (stats.pass_td  || 0) * s.pass_td
  pts += (stats.pass_yd  || 0) * s.pass_yd
  pts += (stats.pass_int || 0) * s.pass_int
  pts += (stats.pass_2pt || 0) * s.pass_2pt
 
  // 350+ yard passing bonus
  if ((stats.pass_yd || 0) >= 350) pts += s.pass_350_bonus || 0
 
  // 40+ yard TD bonus (passing)
  pts += (stats.pass_40_plus_td || 0) * (s.pass_40_td_bonus || 0)
 
  // ── Rushing ──
  pts += (stats.rush_td  || 0) * s.rush_td
  pts += (stats.rush_yd  || 0) * s.rush_yd
  pts += (stats.rush_2pt || 0) * (s.rush_2pt || 2)
 
  // 150+ yard rushing bonus
  if ((stats.rush_yd || 0) >= 150) pts += s.rush_150_bonus || 0
 
  // 40+ yard rushing TD bonus
  pts += (stats.rush_40_plus_td || 0) * (s.rush_40_td_bonus || 0)
 
  // ── Receiving ──
  pts += (stats.rec_td  || 0) * s.rec_td
  pts += (stats.rec_yd  || 0) * s.rec_yd
  pts += (stats.rec     || 0) * s.rec
  pts += (stats.rec_2pt || 0) * (s.rec_2pt || 2)
 
  // 150+ yard receiving bonus
  if ((stats.rec_yd || 0) >= 150) pts += s.rec_150_bonus || 0
 
  // 40+ yard receiving TD bonus
  pts += (stats.rec_40_plus_td || 0) * (s.rec_40_td_bonus || 0)
 
  // 40+ yard reception bonus (per catch over 40 yards)
  pts += (stats.rec_40_plus || 0) * (s.rec_40_yd_bonus || 0)
 
  // ── Misc ──
  pts += (stats.fum_lost  || 0) * s.fum_lost
  pts += (stats.fum_rec_td|| 0) * (s.fum_rec_td || 6)
 
  // ── Kicker ──
  // FG by distance
  pts += (stats.fg_made_0_19  || stats.fg_made_0_39  || 0) * s.fg_0_39
  pts += (stats.fg_made_20_29 || 0) * s.fg_0_39
  pts += (stats.fg_made_30_39 || 0) * s.fg_0_39
  pts += (stats.fg_made_40_49 || 0) * s.fg_40_49
  pts += (stats.fg_made_50_59 || 0) * s.fg_50_59
  pts += (stats.fg_made_60    || stats.fg_made_60_plus || 0) * s.fg_60_plus
  pts += (stats.fg_miss       || 0) * s.fg_miss
  pts += (stats.pat_made      || 0) * s.pat_made
  pts += (stats.pat_miss      || 0) * s.pat_miss
 
  // ── Defense / Special Teams ──
  pts += (stats.sack        || 0) * (s.def_sack         || 0)
  pts += (stats.int         || 0) * (s.def_int           || 0)
  pts += (stats.fum_rec     || 0) * (s.def_fum_rec       || 0)
  pts += (stats.safety      || 0) * (s.def_safety        || 0)
  pts += (stats.def_td      || 0) * (s.def_td            || 0)
  pts += (stats.blk_kick    || 0) * (s.def_blocked_kick  || 0)
 
  // Points allowed bracket
  const ptsAllowed = stats.pts_allow || stats.pts_allowed || null
  if (ptsAllowed !== null) {
    if (ptsAllowed === 0)           pts += s.def_pts_allowed_0      || 0
    else if (ptsAllowed <= 6)       pts += s.def_pts_allowed_1_6    || 0
    else if (ptsAllowed <= 13)      pts += s.def_pts_allowed_7_13   || 0
    else if (ptsAllowed <= 20)      pts += s.def_pts_allowed_14_20  || 0
    else if (ptsAllowed <= 27)      pts += s.def_pts_allowed_21_27  || 0
    else if (ptsAllowed <= 34)      pts += s.def_pts_allowed_28_34  || 0
    else                            pts += s.def_pts_allowed_35_plus || 0
  }
 
  // Yards allowed bracket
  const ydsAllowed = stats.yds_allow || stats.yds_allowed || null
  if (ydsAllowed !== null) {
    if (ydsAllowed < 100)       pts += s.def_yds_allowed_0_99    || 0
    else if (ydsAllowed < 200)  pts += s.def_yds_allowed_100_199 || 0
    else if (ydsAllowed < 300)  pts += s.def_yds_allowed_200_299 || 0
    else if (ydsAllowed < 350)  pts += s.def_yds_allowed_300_349 || 0
    else if (ydsAllowed < 400)  pts += s.def_yds_allowed_350_399 || 0
    else if (ydsAllowed < 450)  pts += s.def_yds_allowed_400_449 || 0
    else if (ydsAllowed < 500)  pts += s.def_yds_allowed_450_499 || 0
    else                        pts += s.def_yds_allowed_500_plus || 0
  }
 
  return Math.round(pts * 100) / 100
}
 
// ─── MLB SCORE CALCULATOR ──────────────────────────────
function calcMLBScore(stats, scoring) {
  if (!stats) return 0
  const s = scoring
 
  // ── Batting ──
  let pts = 0
  pts += (stats.single || 0) * s.single
  pts += (stats.double || 0) * s.double
  pts += (stats.triple || 0) * s.triple
  pts += (stats.hr     || 0) * s.hr
  pts += (stats.rbi    || 0) * s.rbi
  pts += (stats.r      || 0) * s.r
  pts += (stats.bb     || 0) * s.bb
  pts += (stats.sb     || 0) * s.sb
  pts += (stats.hbp    || 0) * s.hbp
  pts += (stats.so     || 0) * s.so       // batter strikeout (negative)
  pts += (stats.cs     || 0) * (s.cs || 0)
 
  // Cycle bonus
  if (stats.cycle) pts += s.cycle_bonus || 0
 
  // ── Pitching ──
  pts += (stats.win  || 0) * s.win
  pts += (stats.ip   || 0) * s.ip
  pts += (stats.ks   || 0) * s.ks
  pts += (stats.er   || 0) * s.er         // earned run (negative)
  pts += (stats.bb_allowed || 0) * s.bb_allowed
  pts += (stats.sv   || 0) * s.sv
  pts += (stats.blown_save || 0) * s.blown_save
  pts += (stats.hold || 0) * (s.hold || 0)
 
  // Quality Start: 6+ IP and 3 or fewer earned runs
  if ((stats.ip || 0) >= 6 && (stats.er || 0) <= 3) {
    pts += s.quality_start || 0
  }
 
  // Pitching milestones
  if (stats.complete_game) pts += s.complete_game || 0
  if (stats.cg_shutout)    pts += s.cg_shutout    || 0
  if (stats.no_hitter)     pts += s.no_hitter     || 0
  if (stats.perfect_game)  pts += s.perfect_game  || 0
 
  return Math.round(pts * 100) / 100
}
 
// ─── DIAMONDUT SCORE FORMULA ───────────────────────────
//
// Mode-based weights:
//
// SEASON LONG / WEEKLY:
//   Week 1:  Season 80%, Recent  0%, Matchup 20%
//   Week 2:  Season 65%, Recent 15%, Matchup 20%
//   Week 3:  Season 55%, Recent 25%, Matchup 20%
//   Week 4+: Season 50%, Recent 30%, Matchup 20%
//
// DAILY CONTEST:
//   Week 1:  Season 55%, Recent 10%, Matchup 35%
//   Week 2:  Season 40%, Recent 25%, Matchup 35%
//   Week 3:  Season 30%, Recent 40%, Matchup 30%
//   Week 4+: Season 25%, Recent 45%, Matchup 30%
//
function calcDiamondUTScore(seasonAvg, recentAvg, matchupScore, weeksPlayed, mode = 'weekly') {
  if (weeksPlayed === 0 && mode === 'weekly') return seasonAvg
 
  const matchupMod = ((matchupScore || 50) - 50) / 50 // -1.0 to +1.0
 
  let seasonWeight, recentWeight, matchupWeight
 
  if (mode === 'daily') {
    // Daily — recent form and matchup dominate
    // Final: Season 25%, Recent 45%, Matchup 30%
    if (weeksPlayed <= 1)       { seasonWeight = 0.55; recentWeight = 0.10; matchupWeight = 0.35 }
    else if (weeksPlayed === 2) { seasonWeight = 0.40; recentWeight = 0.25; matchupWeight = 0.35 }
    else if (weeksPlayed === 3) { seasonWeight = 0.30; recentWeight = 0.40; matchupWeight = 0.30 }
    else                        { seasonWeight = 0.25; recentWeight = 0.45; matchupWeight = 0.30 }
  } else {
    // Weekly / Season long — season stats dominate
    // Final: Season 50%, Recent 30%, Matchup 20%
    if (weeksPlayed <= 1)       { seasonWeight = 0.80; recentWeight = 0.00; matchupWeight = 0.20 }
    else if (weeksPlayed === 2) { seasonWeight = 0.65; recentWeight = 0.15; matchupWeight = 0.20 }
    else if (weeksPlayed === 3) { seasonWeight = 0.55; recentWeight = 0.25; matchupWeight = 0.20 }
    else                        { seasonWeight = 0.50; recentWeight = 0.30; matchupWeight = 0.20 }
  }
 
  // Base score from season + recent form
  const baseScore = (seasonAvg * seasonWeight) + (recentAvg * recentWeight)
 
  // Matchup modifier: +1.0 = perfect matchup, -1.0 = worst matchup
  const matchupBoost = baseScore * matchupWeight * matchupMod
 
  return Math.max(0, Math.round((baseScore + matchupBoost) * 100) / 100)
}
 
// ─── PERFORMANCE FLAGS ─────────────────────────────────
function calcFlags(player) {
  const { seasonAvgPts: seasonAvg, recentAvgPts: recentAvg, tier } = player
 
  const isHot     = recentAvg > 0 && seasonAvg > 0 && recentAvg >= seasonAvg * 1.25
  const isCold    = recentAvg > 0 && seasonAvg > 0 && recentAvg <= seasonAvg * 0.75
  const isSleeper = ['silver','bronze'].includes(tier) && recentAvg >= 8
  const variance  = seasonAvg > 0 ? Math.abs(recentAvg - seasonAvg) / seasonAvg : 0
  const isUpside  = tier === 'gold' && variance >= 0.35
 
  return { isHot, isCold, isSleeper, isUpside }
}
 
// ─── TIER ASSIGNMENT ───────────────────────────────────
function assignTier(rank, position, sport) {
  const thresholds = sport === 'NFL'
    ? (NFL_TIER_THRESHOLDS[position] || NFL_TIER_THRESHOLDS.WR)
    : (MLB_TIER_THRESHOLDS[position] || MLB_TIER_THRESHOLDS.OF)
 
  if (rank <= thresholds.legendary) return 'legendary'
  if (rank <= thresholds.platinum)  return 'platinum'
  if (rank <= thresholds.gold)      return 'gold'
  if (rank <= thresholds.silver)    return 'silver'
  return 'bronze'
}
 
// ─── ACTIVE PLAYER FILTER ──────────────────────────────
function isActivePlayer(player, sport) {
  if (!player.team || player.team === 'FA' || player.team === '') return false
  if (player.active === false) return false
  const validPos = sport === 'NFL'
    ? Object.keys(NFL_TIER_THRESHOLDS)
    : Object.keys(MLB_TIER_THRESHOLDS)
  if (!player.position || !validPos.includes(player.position)) return false
  return true
}
 
// ─── MAIN RANKING FUNCTION ─────────────────────────────
function rankPlayers(players, seasonStats, recentStats, matchupData, sport, scoringFormat, mode = 'weekly') {
  const scoring = sport === 'NFL'
    ? (typeof scoringFormat === 'object' ? scoringFormat : (NFL_SCORING[scoringFormat] || NFL_SCORING.half_ppr))
    : (typeof scoringFormat === 'object' ? scoringFormat : MLB_SCORING_DEFAULT)
 
  const calcScore = sport === 'NFL' ? calcNFLScore : calcMLBScore
 
  // Score every active player
  const scored = players
    .filter(p => isActivePlayer(p, sport))
    .map(p => {
      const pid = p.player_id || p.sleeper_id
 
      const seasonRaw  = seasonStats[pid] || {}
      const weeksPlayed = seasonRaw.gp || seasonRaw.games_played || 0
      const seasonTotal = calcScore(seasonRaw, scoring)
      const seasonAvg   = weeksPlayed > 0 ? seasonTotal / weeksPlayed : 0
 
      const recentRaw   = recentStats[pid] || {}
      const recentTotal = calcScore(recentRaw, scoring)
      const recentGames = recentRaw.gp || 3
      const recentAvg   = recentGames > 0 ? recentTotal / recentGames : seasonAvg
 
      const matchupScore    = matchupData[pid] || 50
      const diamondUTScore  = calcDiamondUTScore(seasonAvg, recentAvg, matchupScore, weeksPlayed, mode)
 
      return {
        player_id:      pid,
        name:           `${p.first_name} ${p.last_name}`,
        position:       p.position,
        team:           p.team,
        sport,
        is_injured:     ['Out','IR','IL','PUP','60-Day IL','NFI','Suspended'].includes(p.injury_status),
        injury_status:  p.injury_status || null,
        diamondUTScore,
        seasonAvgPts:   Math.round(seasonAvg  * 100) / 100,
        recentAvgPts:   Math.round(recentAvg  * 100) / 100,
        seasonTotalPts: Math.round(seasonTotal * 100) / 100,
        weeksPlayed,
        matchupScore,
        headshot_url:   `https://sleepercdn.com/content/${sport.toLowerCase()}/players/thumb/${pid}.jpg`
      }
    })
 
  // Rank within each position and assign tiers
  const positions = sport === 'NFL'
    ? Object.keys(NFL_TIER_THRESHOLDS)
    : Object.keys(MLB_TIER_THRESHOLDS)
 
  const allRanked = []
 
  for (const pos of positions) {
    const atPos = scored
      .filter(p => p.position === pos)
      .sort((a, b) => b.diamondUTScore - a.diamondUTScore)
 
    atPos.forEach((p, idx) => {
      const rank = idx + 1
      const tier = assignTier(rank, pos, sport)
      const withTier = { ...p, tier, tier_value: TIER_VALUES[tier], position_rank: rank, projected_points: p.diamondUTScore }
      const flags = calcFlags(withTier)
      allRanked.push({ ...withTier, is_sleeper: flags.isSleeper, is_upside: flags.isUpside, is_hot: flags.isHot, is_cold: flags.isCold })
    })
  }
 
  return allRanked
}
 
 
 
// ─── FETCH WITH TIMEOUT ────────────────────────────────
async function fetchWithTimeout(url, timeoutMs = 25000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch(e) {
    clearTimeout(timer)
    throw e
  }
}
 
// ─── PARSE CSV ─────────────────────────────────────────
function parseCSV(text) {
  const lines   = text.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
  const rows    = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',')
    if (vals.length < headers.length) continue
    const row = {}
    headers.forEach((h, idx) => {
      const v = (vals[idx] || '').trim().replace(/"/g, '')
      row[h] = v === '' || v === 'NA' ? null : v
    })
    rows.push(row)
  }
  return rows
}
 
// ─── FETCH SLEEPER PLAYERS ─────────────────────────────
async function fetchSleeperPlayers(sport) {
  const res = await fetchWithTimeout(`https://api.sleeper.app/v1/players/${sport.toLowerCase()}`)
  if (!res.ok) throw new Error(`Sleeper ${sport} failed: ${res.status}`)
  return res.json()
}
 
// ─── PROCESS NFL ───────────────────────────────────────
async function processNFL() {
  console.log('Processing NFL...')
  const now    = new Date()
  const year   = now.getFullYear()
  const month  = now.getMonth() + 1
  const season = month <= 2 ? year - 1 : year
 
  const sleeperPlayers = await fetchSleeperPlayers('nfl')
 
  // Try nflfastR season summary CSV
  let statsRows = []
  for (const s of [season, season - 1]) {
    try {
      const url = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_season_${s}.csv`
      console.log(`Trying nflfastR ${s}...`)
      const res = await fetchWithTimeout(url, 20000)
      if (!res.ok) continue
      const text = await res.text()
      statsRows = parseCSV(text)
      if (statsRows.length > 50) {
        console.log(`Got ${statsRows.length} rows for ${s}`)
        break
      }
    } catch(e) {
      console.log(`nflfastR ${s} failed: ${e.message}`)
    }
  }
 
  if (statsRows.length > 50) {
    return processNFLWithStats(statsRows, sleeperPlayers)
  }
 
  console.log('Using Sleeper position ranking fallback')
  return processNFLFallback(sleeperPlayers)
}
 
// NFL with real stats
function processNFLWithStats(statsRows, sleeperPlayers) {
  const scoring = NFL_SCORING.half_ppr
 
  const nameToSleeper = {}
  Object.values(sleeperPlayers).forEach(p => {
    if (!p.first_name || !p.last_name) return
    const key = `${p.first_name} ${p.last_name}`.toLowerCase().replace(/[^a-z ]/g, '')
    nameToSleeper[key] = p
  })
 
  const byPlayer = {}
  for (const row of statsRows) {
    const pos = row.position
    if (!pos || !NFL_POSITIONS.includes(pos)) continue
    const pid = row.player_id
    if (!pid) continue
    byPlayer[pid] = {
      pid, pos,
      name:     row.player_display_name || row.player_name || '',
      team:     row.recent_team || '',
      games:    +row.games || 1,
      pass_yd:  +row.passing_yards   || 0,
      pass_td:  +row.passing_tds     || 0,
      pass_int: +row.interceptions   || 0,
      rush_yd:  +row.rushing_yards   || 0,
      rush_td:  +row.rushing_tds     || 0,
      rec_yd:   +row.receiving_yards || 0,
      rec_td:   +row.receiving_tds   || 0,
      rec:      +row.receptions      || 0,
      fum_lost: (+row.sack_fumbles_lost || 0) + (+row.rushing_fumbles_lost || 0)
    }
  }
 
  console.log(`Got ${Object.keys(byPlayer).length} NFL players from season summary`)
 
  const scored = []
  for (const stats of Object.values(byPlayer)) {
    if (!stats.team || stats.team === 'FA' || stats.games === 0) continue
    const nameKey = stats.name.toLowerCase().replace(/[^a-z ]/g, '')
    const sleeper = nameToSleeper[nameKey]
    const sleeperTeam = sleeper?.team || stats.team
    if (!sleeperTeam || sleeperTeam === 'FA') continue
    const seasonPts = calcNFLScore(stats, scoring)
    const avgPts    = seasonPts / stats.games
    scored.push({
      sleeper_id:     sleeper?.player_id || `nfl_${stats.pid}`,
      name:           stats.name,
      position:       stats.pos,
      team:           sleeperTeam,
      sport:          'NFL',
      is_injured:     INJURED_STATUSES.includes(sleeper?.injury_status),
      seasonTotalPts: Math.round(seasonPts * 100) / 100,
      seasonAvgPts:   Math.round(avgPts * 100) / 100,
      headshot_url:   sleeper ? `https://sleepercdn.com/content/nfl/players/thumb/${sleeper.player_id}.jpg` : null
    })
  }
 
  return rankAndTier(scored, 'NFL', false)
}
 
// NFL fallback
function processNFLFallback(sleeperPlayers) {
  const scored = Object.values(sleeperPlayers)
    .filter(p =>
      p.team && p.team !== 'FA' && p.team !== '' &&
      p.active !== false &&
      p.position && NFL_POSITIONS.includes(p.position) &&
      p.first_name && p.last_name
    )
    .map(p => ({
      sleeper_id:     p.player_id,
      name:           `${p.first_name} ${p.last_name}`,
      position:       p.position,
      team:           p.team,
      sport:          'NFL',
      is_injured:     INJURED_STATUSES.includes(p.injury_status),
      seasonTotalPts: 0,
      seasonAvgPts:   0,
      search_rank:    p.search_rank || 999999,
      headshot_url:   `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`
    }))
  return rankAndTier(scored, 'NFL', true)
}
 
// ─── PROCESS MLB ───────────────────────────────────────
async function processMLB() {
  console.log('Processing MLB...')
  const sleeperPlayers = await fetchSleeperPlayers('mlb')
  const scored = Object.values(sleeperPlayers)
    .filter(p =>
      p.team && p.team !== 'FA' && p.team !== '' &&
      p.active !== false &&
      p.position && MLB_POSITIONS.includes(p.position) &&
      p.first_name && p.last_name
    )
    .map(p => ({
      sleeper_id:     p.player_id,
      name:           `${p.first_name} ${p.last_name}`,
      position:       p.position,
      team:           p.team,
      sport:          'MLB',
      is_injured:     INJURED_STATUSES.includes(p.injury_status),
      seasonTotalPts: 0,
      seasonAvgPts:   0,
      search_rank:    p.search_rank || 999999,
      headshot_url:   `https://sleepercdn.com/content/mlb/players/thumb/${p.player_id}.jpg`
    }))
  console.log(`Active MLB players: ${scored.length}`)
  return rankAndTier(scored, 'MLB', true)
}
 
// ─── RANK AND ASSIGN TIERS ─────────────────────────────
function rankAndTier(players, sport, useSearchRank) {
  const positions = sport === 'NFL' ? NFL_POSITIONS : MLB_POSITIONS
  const ranked    = []
  for (const pos of positions) {
    const atPos = players
      .filter(p => p.position === pos)
      .sort((a, b) => useSearchRank
        ? (a.search_rank || 999999) - (b.search_rank || 999999)
        : b.seasonAvgPts - a.seasonAvgPts
      )
    console.log(`${pos}: ${atPos.length} players`)
    atPos.forEach((p, idx) => {
      const tier = assignTier(idx + 1, pos, sport)
      ranked.push({
        sleeper_id:       p.sleeper_id,
        name:             p.name,
        position:         p.position,
        team:             p.team,
        sport,
        tier,
        tier_value:       TIER_VALUES[tier],
        projected_points: p.seasonAvgPts || 0,
        actual_points:    p.seasonTotalPts || 0,
        is_injured:       p.is_injured || false,
        is_sleeper:       false,
        is_upside:        false,
        headshot_url:     p.headshot_url,
        updated_at:       new Date().toISOString()
      })
    })
  }
  return ranked
}
 
// ─── SAVE TO SUPABASE ───────────────────────────────────
async function saveToSupabase(players) {
  const seen = new Map()
  players.forEach(p => seen.set(p.sleeper_id, p))
  const deduped = Array.from(seen.values())
  console.log(`Saving ${deduped.length} players...`)
  const batchSize = 250
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize)
    const { error } = await supabase
      .from('players')
      .upsert(batch, { onConflict: 'sleeper_id', ignoreDuplicates: false })
    if (error) throw new Error(`Batch ${i} error: ${error.message}`)
  }
  console.log('Save complete')
}
 
// ─── MAIN HANDLER ───────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.PIPELINE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    console.log('DiamondUT sync v5 starting...')
    const nflRanked = await processNFL()
    console.log(`NFL done: ${nflRanked.length} players`)
    const mlbRanked = await processMLB()
    console.log(`MLB done: ${mlbRanked.length} players`)
    await saveToSupabase([...nflRanked, ...mlbRanked])
    const nflBreakdown = {}, mlbBreakdown = {}
    nflRanked.forEach(p => { nflBreakdown[p.tier] = (nflBreakdown[p.tier]||0)+1 })
    mlbRanked.forEach(p => { mlbBreakdown[p.tier] = (mlbBreakdown[p.tier]||0)+1 })
    const nflLeg = nflRanked.filter(p => p.tier === 'legendary').map(p => `${p.name} (${p.position}) ${p.projected_points}ppg`)
    const mlbLeg = mlbRanked.filter(p => p.tier === 'legendary').map(p => `${p.name} (${p.position})`)
    return res.status(200).json({
      success: true,
      nfl_count: nflRanked.length,
      mlb_count: mlbRanked.length,
      total: nflRanked.length + mlbRanked.length,
      nfl_breakdown: nflBreakdown,
      mlb_breakdown: mlbBreakdown,
      nfl_legendary: nflLeg,
      mlb_legendary: mlbLeg
    })
  } catch(err) {
    console.error('Sync error:', err)
    return res.status(500).json({ error: err.message })
  }
}
 
