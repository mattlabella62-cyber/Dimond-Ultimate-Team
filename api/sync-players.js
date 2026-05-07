// ═══════════════════════════════════════════════════════
// DiamondUT — Player Sync v5
// api/sync-players.js
//
// Set maxDuration to 60 seconds for Vercel Pro
// or use the split approach for free tier
// ═══════════════════════════════════════════════════════
 
const { createClient } = require('@supabase/supabase-js')
const { calcNFLScore, assignTier, TIER_VALUES, NFL_SCORING } = require('./ranking-engine')
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
 
// Tell Vercel this function can run up to 60 seconds
module.exports.config = { maxDuration: 60 }
 
const NFL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K']
const MLB_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'SP', 'RP']
const INJURED_STATUSES = ['Out', 'IR', 'IL', 'PUP', '60-Day IL', 'NFI', 'Suspended']
 
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
 
// ─── FETCH WITH TIMEOUT ────────────────────────────────
async function fetchWithTimeout(url, timeoutMs = 30000) {
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
 
  // Fetch Sleeper players first (fast)
  const sleeperPlayers = await fetchSleeperPlayers('nfl')
 
  // Try nflfastR CSV for real stats
  let statsRows = []
  for (const s of [season, season - 1]) {
    try {
      const url = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${s}.csv`
      console.log(`Trying nflfastR ${s}...`)
      const res = await fetchWithTimeout(url, 20000)
      if (!res.ok) continue
      const text = await res.text()
      statsRows = parseCSV(text)
      if (statsRows.length > 100) {
        console.log(`Got ${statsRows.length} rows for ${s}`)
        break
      }
    } catch(e) {
      console.log(`nflfastR ${s} failed: ${e.message}`)
    }
  }
 
  // If we got real stats — use them
  if (statsRows.length > 100) {
    return processNFLWithStats(statsRows, sleeperPlayers)
  }
 
  // Fallback to Sleeper position ranking
  console.log('Using Sleeper position ranking fallback')
  return processNFLFallback(sleeperPlayers)
}
 
// NFL with real nflfastR stats
function processNFLWithStats(statsRows, sleeperPlayers) {
  const scoring = NFL_SCORING.half_ppr
 
  // Build Sleeper lookup by name
  const nameToSleeper = {}
  Object.values(sleeperPlayers).forEach(p => {
    if (!p.first_name || !p.last_name) return
    const key = `${p.first_name} ${p.last_name}`.toLowerCase().replace(/[^a-z ]/g, '')
    nameToSleeper[key] = p
  })
 
  // Aggregate season stats per player
  const byPlayer = {}
  for (const row of statsRows) {
    const pos = row.position
    if (!pos || !NFL_POSITIONS.includes(pos)) continue
    const pid = row.player_id
    if (!pid) continue
 
    if (!byPlayer[pid]) {
      byPlayer[pid] = {
        pid, pos,
        name:  row.player_display_name || row.player_name || '',
        team:  row.recent_team || '',
        games: 0,
        pass_yd:0, pass_td:0, pass_int:0, pass_2pt:0,
        rush_yd:0, rush_td:0, rush_2pt:0,
        rec_yd:0,  rec_td:0,  rec:0,     rec_2pt:0,
        fum_lost:0
      }
    }
 
    const p = byPlayer[pid]
    p.games++
    p.team     = row.recent_team || p.team
    p.pass_yd  += +row.passing_yards   || 0
    p.pass_td  += +row.passing_tds     || 0
    p.pass_int += +row.interceptions   || 0
    p.rush_yd  += +row.rushing_yards   || 0
    p.rush_td  += +row.rushing_tds     || 0
    p.rec_yd   += +row.receiving_yards || 0
    p.rec_td   += +row.receiving_tds   || 0
    p.rec      += +row.receptions      || 0
    p.fum_lost += (+row.sack_fumbles_lost || 0) + (+row.rushing_fumbles_lost || 0)
  }
 
  console.log(`Aggregated ${Object.keys(byPlayer).length} NFL players`)
 
  // Score and match to Sleeper
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
 
// NFL fallback using Sleeper search_rank
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
 
