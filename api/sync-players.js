// ═══════════════════════════════════
// DiamondUT — Sleeper API Pipeline
// File location in your repo:
// /api/sync-players.js
//
// This runs every Monday at 6am to:
// 1. Fetch all MLB + NFL players
// 2. Fetch weekly projections
// 3. Auto-tier by position rank
// 4. Flag sleepers + upside players
// 5. Save to Supabase players table
// ═══════════════════════════════════
 
const { createClient } = require('@supabase/supabase-js')
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // uses service role for server-side writes
)
 
// ═══════════════════════════════════
// TIER THRESHOLDS BY POSITION
// Based on rank at their position
// ═══════════════════════════════════
const MLB_TIERS = {
  legendary: 3,   // top 3 at position
  platinum:  15,  // 4-15
  gold:      40,  // 16-40
  silver:    80,  // 41-80
  bronze:    999  // 81+
}
 
const NFL_TIERS = {
  legendary: 2,   // top 2 at position
  platinum:  10,  // 3-10
  gold:      24,  // 11-24
  silver:    40,  // 25-40
  bronze:    999  // 41+
}
 
const TIER_VALUES = {
  legendary: 200,
  platinum:  100,
  gold:      60,
  silver:    25,
  bronze:    10
}
 
// Positions we track
const MLB_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'SP', 'RP']
const NFL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K']
 
// ═══════════════════════════════════
// FETCH ALL PLAYERS FROM SLEEPER
// ═══════════════════════════════════
async function fetchSleeperPlayers(sport) {
  // Sleeper has separate endpoints for each sport
  // sport should be 'nfl' or 'mlb'
  const res = await fetch(`https://api.sleeper.app/v1/players/${sport.toLowerCase()}`)
  if (!res.ok) throw new Error(`Failed to fetch ${sport} players: ${res.status}`)
  return res.json()
}
 
// ═══════════════════════════════════
// FETCH PROJECTIONS FROM SLEEPER
// ═══════════════════════════════════
async function fetchProjections(sport, season, week) {
  const res = await fetch(
    `https://api.sleeper.app/v1/projections/${sport}/${season}/${week}?season_type=regular&position[]=${
      sport === 'nfl'
        ? NFL_POSITIONS.join('&position[]=')
        : MLB_POSITIONS.join('&position[]=')
    }`
  )
  if (!res.ok) return {}
  return res.json()
}
 
// ═══════════════════════════════════
// CALCULATE FANTASY POINTS FROM STATS
// Standard MLB scoring
// ═══════════════════════════════════
function calcMLBPoints(stats) {
  if (!stats) return 0
  return (
    (stats.single        || 0) * 1   +
    (stats.double        || 0) * 2   +
    (stats.triple        || 0) * 3   +
    (stats.hr            || 0) * 4   +
    (stats.rbi           || 0) * 1   +
    (stats.r             || 0) * 1   +
    (stats.bb            || 0) * 1   +
    (stats.sb            || 0) * 2   +
    (stats.hbp           || 0) * 1   +
    (stats.so            || 0) * -1  +  // batter strikeout
    (stats.win           || 0) * 5   +
    (stats.outs          || 0) * 0.33+  // innings pitched
    (stats.ks            || 0) * 1   +  // pitcher strikeouts
    (stats.er            || 0) * -1  +
    (stats.bb_against    || 0) * -0.5+
    (stats.sv            || 0) * 5   +
    (stats.blown_save    || 0) * -3
  )
}
 
// Half PPR NFL scoring
function calcNFLPoints(stats) {
  if (!stats) return 0
  return (
    (stats.pass_td       || 0) * 4   +
    (stats.pass_yd       || 0) * 0.04+
    (stats.pass_int      || 0) * -2  +
    (stats.rush_td       || 0) * 6   +
    (stats.rush_yd       || 0) * 0.1 +
    (stats.rec_td        || 0) * 6   +
    (stats.rec_yd        || 0) * 0.1 +
    (stats.rec           || 0) * 0.5 +  // half PPR
    (stats.fum_lost      || 0) * -2  +
    (stats.two_pt_conv   || 0) * 2
  )
}
 
// ═══════════════════════════════════
// ASSIGN TIER BY POSITION RANK
// ═══════════════════════════════════
function assignTier(rank, sport) {
  const thresholds = sport === 'MLB' ? MLB_TIERS : NFL_TIERS
  if (rank <= thresholds.legendary) return 'legendary'
  if (rank <= thresholds.platinum)  return 'platinum'
  if (rank <= thresholds.gold)      return 'gold'
  if (rank <= thresholds.silver)    return 'silver'
  return 'bronze'
}
 
// ═══════════════════════════════════
// FLAG SLEEPERS + UPSIDE PLAYERS
// Sleeper = Silver/Bronze with 20%+ above season avg
// Upside  = Gold with 40%+ variance ceiling vs floor
// ═══════════════════════════════════
function flagSleeper(player, weekProjected, seasonAvg) {
  if (!weekProjected || !seasonAvg || seasonAvg === 0) return false
  if (!['silver', 'bronze'].includes(player.tier)) return false
  return weekProjected >= seasonAvg * 1.2
}
 
function flagUpside(player, ceilingProjected, floorProjected) {
  if (!ceilingProjected || !floorProjected || floorProjected === 0) return false
  if (player.tier !== 'gold') return false
  return ceilingProjected >= floorProjected * 1.4
}
 
// ═══════════════════════════════════
// PROCESS MLB PLAYERS
// ═══════════════════════════════════
async function processMLB(season, week) {
  console.log('Fetching MLB players from Sleeper...')
  const allPlayers = await fetchSleeperPlayers('mlb')
 
  // Filter to active MLB players only
  const mlbPlayers = Object.values(allPlayers).filter(p =>
    p.active &&
    p.position &&
    MLB_POSITIONS.includes(p.position)
  )
 
  console.log(`Found ${mlbPlayers.length} active MLB players`)
 
  // Fetch this week's projections
  const projections = await fetchProjections('mlb', season, week)
 
  // Group by position and sort by projected points
  const byPosition = {}
  for (const pos of MLB_POSITIONS) {
    byPosition[pos] = mlbPlayers
      .filter(p => p.position === pos)
      .map(p => {
        const proj = projections[p.player_id]?.stats || {}
        const pts = calcMLBPoints(proj)
        return { ...p, projectedPoints: pts }
      })
      .sort((a, b) => b.projectedPoints - a.projectedPoints)
  }
 
  // Assign tiers by rank within position
  const processed = []
  for (const [pos, players] of Object.entries(byPosition)) {
    players.forEach((p, idx) => {
      const rank = idx + 1
      const tier = assignTier(rank, 'MLB')
      processed.push({
        sleeper_id: p.player_id,
        name: `${p.first_name} ${p.last_name}`,
        position: p.position,
        team: p.team || 'FA',
        sport: 'MLB',
        tier,
        tier_value: TIER_VALUES[tier],
        projected_points: p.projectedPoints,
        is_injured: p.injury_status === 'Out' || p.injury_status === 'IR',
        is_sleeper: false, // flagged below
        is_upside: false,
        headshot_url: `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`,
        updated_at: new Date().toISOString()
      })
    })
  }
 
  // Flag sleepers and upside
  processed.forEach(p => {
    p.is_sleeper = flagSleeper(p, p.projected_points, p.projected_points * 0.8)
    p.is_upside = flagUpside(p, p.projected_points * 1.4, p.projected_points * 0.7)
  })
 
  return processed
}
 
// ═══════════════════════════════════
// PROCESS NFL PLAYERS
// ═══════════════════════════════════
async function processNFL(season, week) {
  console.log('Fetching NFL players from Sleeper...')
  const allPlayers = await fetchSleeperPlayers('nfl')
 
  const nflPlayers = Object.values(allPlayers).filter(p =>
    p.sport === 'nfl' &&
    p.active &&
    p.position &&
    NFL_POSITIONS.includes(p.position)
  )
 
  console.log(`Found ${nflPlayers.length} active NFL players`)
 
  const projections = await fetchProjections('nfl', season, week)
 
  // Group by position and sort
  const byPosition = {}
  for (const pos of NFL_POSITIONS) {
    byPosition[pos] = nflPlayers
      .filter(p => p.position === pos)
      .map(p => {
        const proj = projections[p.player_id]?.stats || {}
        const pts = calcNFLPoints(proj)
        return { ...p, projectedPoints: pts }
      })
      .sort((a, b) => b.projectedPoints - a.projectedPoints)
  }
 
  const processed = []
  for (const [pos, players] of Object.entries(byPosition)) {
    players.forEach((p, idx) => {
      const rank = idx + 1
      const tier = assignTier(rank, 'NFL')
      processed.push({
        sleeper_id: p.player_id,
        name: `${p.first_name} ${p.last_name}`,
        position: p.position,
        team: p.team || 'FA',
        sport: 'NFL',
        tier,
        tier_value: TIER_VALUES[tier],
        projected_points: p.projectedPoints,
        is_injured: p.injury_status === 'Out' || p.injury_status === 'IR',
        is_sleeper: false,
        is_upside: false,
        headshot_url: `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`,
        updated_at: new Date().toISOString()
      })
    })
  }
 
  processed.forEach(p => {
    p.is_sleeper = flagSleeper(p, p.projected_points, p.projected_points * 0.8)
    p.is_upside = flagUpside(p, p.projected_points * 1.4, p.projected_points * 0.7)
  })
 
  return processed
}
 
// ═══════════════════════════════════
// SAVE TO SUPABASE
// Upserts so re-running never
// creates duplicates
// ═══════════════════════════════════
async function saveToSupabase(players) {
  console.log(`Saving ${players.length} players to Supabase...`)
 
  // Deduplicate by sleeper_id — keep last occurrence
  const seen = new Map()
  for (const p of players) {
    seen.set(p.sleeper_id, p)
  }
  const deduped = Array.from(seen.values())
  console.log(`After dedup: ${deduped.length} unique players`)
 
  // Batch in groups of 250 to avoid request size limits
  const batchSize = 250
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize)
    const { error } = await supabase
      .from('players')
      .upsert(batch, { onConflict: 'sleeper_id', ignoreDuplicates: false })
 
    if (error) {
      console.error(`Batch ${i} error:`, error)
      throw error
    }
    console.log(`Saved batch ${i} - ${i + batch.length}`)
  }
}
 
// ═══════════════════════════════════
// MAIN HANDLER
// Called by Vercel on schedule
// or manually via GET request
// ═══════════════════════════════════
module.exports = async function handler(req, res) {
  // Protect endpoint with a secret key
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.PIPELINE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
 
  try {
    const season = new Date().getFullYear()
    const week = req.query.week || 1
 
    console.log(`Starting player sync — Season ${season} Week ${week}`)
 
    // Process both sports
    const [mlbPlayers, nflPlayers] = await Promise.all([
      processMLB(season, week),
      processNFL(season, week)
    ])
 
    const allPlayers = [...mlbPlayers, ...nflPlayers]
    await saveToSupabase(allPlayers)
 
    console.log(`Sync complete — ${allPlayers.length} players saved`)
 
    return res.status(200).json({
      success: true,
      mlb_count: mlbPlayers.length,
      nfl_count: nflPlayers.length,
      total: allPlayers.length,
      season,
      week
    })
 
  } catch (err) {
    console.error('Pipeline error:', err)
    return res.status(500).json({ error: err.message })
  }
}
